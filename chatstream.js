const ChatStream = (function() {
  class StreamController {
    #_isGenerating = false
    #_isDone = false
    #_isError = false
    #_response = ''
    #_isCancelled = false
    #id = null
    #tokenAmount = 0
    #startWaiting = null
    #startGeneration = null
    #toolCalls = []
    #lastThrottleTime = 0
    #queuedTokens = ''
    #throttleTimeout = null
    #statusInterval = null
    #model = null
    #options = {}
    #onToken = null
    #tokenThrottleMS = 80
    #statusIntervalMS = 250

    get isGenerating() {
      return this.#_isGenerating
    }

    get isDone() {
      return this.#_isDone
    }

    get isError() {
      return this.#_isError
    }

    get isCancelled() {
      return this.#_isCancelled
    }

    get response() {
      return this.#_response
    }

    constructor(options = {}) {
      this.#options = options
    }

    async stream({ id, messages, model, tools, max_tokens, temperature }) {
      if (this.#_isGenerating) {
        return
      }

      this.#id = id
      this.#onToken = this.#options.onToken
      this.#tokenAmount = 0
      this.#toolCalls = []
      this.#startGeneration = null 
      this.#startWaiting = new Date()
      this.#_response = ''
      this.#_isCancelled = false
      this.#_isError = false
      this.#_isDone = false
      this.#_isGenerating = true
      this.#model = model

      try {
        this.#options.onStart?.(id)
        this.#statusInterval = this.#options.onStatus ? setInterval(() => {
          this.#options.onStatus?.(this.#status(), id)
          if (!this.#_isGenerating && !this.#throttleTimeout) {
            clearInterval(this.#statusInterval)
            this.#options.onEnd?.(id)
          }
        }, this.#statusIntervalMS) : null;

        await this.#completionsCall(messages, model, tools, max_tokens, temperature)

        while (this.#options.onToolCall && !this.#_isCancelled && (this.#toolCalls = this.#toolCalls.filter(this.#filterTools.bind(this))).length) {
          messages.push({
            role: 'assistant',
            content: this.#_response,
            tool_calls: this.#toolCalls.slice()
          })

          for (const tc of this.#toolCalls) {              
            try {
              const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : undefined
              const result = await this.#options.onToolCall(tc.function.name, args, id)
              if (result) {
                messages.push({
                  role: 'tool',
                  content: JSON.stringify(result),
                  tool_call_id: tc.id
                })
              }
            } catch (e) {
              console.warn(`Tool call failed: ${tc.function.name}`, tc.function.arguments, e)
            }
          }

          this.#toolCalls = []
          await this.#completionsCall(messages, model, tools, max_tokens, temperature)
        }

        if (!this.#_isCancelled) {
          setTimeout(() => {
            this.#_isDone = true
            this.#options.onComplete?.(this.#_response, this.#status(), id)
          }, this.#tokenThrottleMS)
        }
      } catch (error) {
        if (!this.#_isCancelled) {
          console.error('Error:', error)
          this.#_isError = true
          this.#options.onError?.(error, id)
        }
      } finally {
        this.#_isGenerating = false
      }
    }

    async #completionsCall(messages, model, tools, max_tokens, temperature) {
      const response = await fetch(this.#options.apiUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#options.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: messages.map(m => ({
            role: m.role,
            content: this.#formatFileContent(m),
            tool_call_id: m.tool_call_id,
            tool_calls: m.tool_calls
          })),
          tools,
          stream: true,
          max_tokens,
          temperature
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let thinking = false

      while (true) {
        const { done, value } = await reader.read()
        if (done || this.#_isCancelled) break

        const chunk = decoder.decode(value)
        buffer += chunk

        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n')
          const line = buffer.substring(0, index + 1)
          buffer = buffer.substring(index + 1)

          try {
            if (line.match(/^Data: \{.*\}/i)) {
              const data = JSON.parse(line.substring(6))
              const delta = data.choices[0].delta

              if (!this.#tokenAmount && !this.#startGeneration) {
                this.#startGeneration = new Date()
              }
              this.#tokenAmount++

              if (delta.content) {
                this.#_response += delta.content
                this.#throttleAppendToken(delta.content)
              } else if (!thinking && delta.tool_calls?.length) {
                delta.tool_calls.forEach(tc => {
                  if (this.#toolCalls.length <= tc.index) {
                    this.#toolCalls.push({
                      id: '',
                      type: 'function',
                      function: { name: '', arguments: '' }
                    })
                  }
                  const call = this.#toolCalls[tc.index]
                  call.id += tc.id || ''
                  call.function.name += tc.function.name || ''
                  call.function.arguments += tc.function.arguments || ''
                })
              }
            }
          } catch (e) {
            console.error('JSON Parse Error:', e.message, 'Data:', line)
          }
        }
      }

      this.#_response += '\n '
      this.#throttleAppendToken('\n ')
    }

    #filterTools(tc, index) {
      return !!tc.id && this.#toolCalls.findIndex(i => 
        i.function?.name === tc.function?.name && 
        i.function?.arguments === tc.function?.arguments
      ) === index
    }

    #formatFileContent(message) {
      if (!message.files?.length) return message.content
      
      return `${message.content}\n\n${message.files.length} file(s) are attached for context:\n${
        message.files.map((f, i) => `[File ${i + 1}: ${f.name}]:\n${f.text}`).join('\n\n')
      }`
    }

    #throttleAppendToken(token) {
      if (!token && !this.#queuedTokens) return
      const now = Date.now()
      const timeSinceLastCall = now - this.#lastThrottleTime

      this.#queuedTokens += token || ''
      if (timeSinceLastCall < this.#tokenThrottleMS) {
        this.#throttleTimeout = setTimeout(() => this.#throttleAppendToken(), timeSinceLastCall)
        return
      }

      clearTimeout(this.#throttleTimeout)
      this.#throttleTimeout = null
      this.#onToken?.(this.#queuedTokens, this.#id)
      this.#queuedTokens = ''
      this.#lastThrottleTime = now
    }

    #status() {
      const timeToFirstToken = this.#startWaiting ? ((this.#startGeneration || new Date()).getTime() - this.#startWaiting.getTime()) / 1000 : null
      const generationTime = this.#startGeneration ? (new Date().getTime() - this.#startGeneration.getTime()) / 1000 : null

      return {
        state: this.#_isError ? 'Error' : (this.#_isCancelled ? 'Cancelled' : (this.#_isDone ? 'Done' : (this.#tokenAmount > 0 ? 'Generating ...' : 'Waiting for first token ...'))),
        generationTime: timeToFirstToken + generationTime,
        generationTimeString: this.#formatDuration(timeToFirstToken + generationTime),
        tokenPerSecond: (this.#tokenAmount / generationTime).toFixed(2),
        tokens: this.#tokenAmount,
        timeToFirstToken,
        timeToFirstTokenString: this.#formatDuration(timeToFirstToken),
        model: this.#model
      }
    }

    #formatDuration(seconds) {
      const ms = Math.floor((seconds % 1) * 10).toFixed(0)
      const s = Math.floor(seconds % 60)
      const m = Math.floor((seconds / 60) % 60)
      const h = Math.floor(seconds / 3600)

      const parts = []
      
      if (h > 0) parts.push(`${h}h `)
      if (m > 0) parts.push(`${m}m `)
      parts.push(`${s}.`)
      parts.push(`${ms}s`)

      return parts.join('')
    }

    async stop() {
      return new Promise(resolve => {
        this.#_isCancelled = true
        this.#onToken = null
        this.#_isGenerating = false

        setTimeout(resolve, Math.max(this.#statusIntervalMS, this.#tokenThrottleMS))
      })
    }
  }

  return {
    create: function(options) {
      return new StreamController(options)
    }
  }
})() 
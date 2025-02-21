const ChatStream = (function() {
  class StreamController {
    #_isGenerating = false
    #cancelStreaming = false
    #tokenAmount = 0
    #startWaiting = null
    #startGeneration = null
    #generatingModel = null
    #toolCalls = []
    #lastThrottleTime = 0
    #queuedTokens = ''
    #throttleTimeout = null
    #statusInterval = null
    #apiUrl = ''
    #apiKey = ''
    #max_tokens = 4096
    #temperature = 0.7

    #options = {}
    #onToken = null
    #onComplete = null
    #onError = null
    #onStatus = null
    #onStart = null
    #onEnd = null

    get isGenerating() {
      return this.#_isGenerating
    }

    constructor(options = {}) {
      this.#options = options
      this.#apiUrl = options.apiUrl || ''
      this.#apiKey = options.apiKey || ''
      this.#max_tokens = options.max_tokens || 4096
      this.#temperature = options.temperature || 0.7
      this.#onComplete = options.onComplete
      this.#onError = options.onError
      this.#onStatus = options.onStatus
      this.#onStart = options.onStart
    }

    async stream({ messages, model, tools }) {
      if (this.#_isGenerating) {
        return
      }

      this.#onToken = this.#options.onToken
      this.#onEnd = this.#options.onEnd
      this.#tokenAmount = 0
      this.#startGeneration = null  
      this.#startWaiting = new Date()
      this.#_isGenerating = true
      this.#cancelStreaming = false
      this.#generatingModel = model
      this.#toolCalls = []

      let agentResponse = ''

      try {
        this.#onStart?.()
        this.#statusInterval = this.#onStatus ? setInterval(() => this.#onStatus?.(this.#getStatusString()), 180) : null;

        agentResponse = await this.#completionsCall({ messages, model, tools })
        
        const filterFunc = (tc, index) => {
          return !!tc.id && this.#toolCalls.findIndex(i => 
            i.function?.name === tc.function?.name && 
            i.function?.arguments === tc.function?.arguments
          ) === index
        }

        while (!this.#cancelStreaming && (this.#toolCalls = this.#toolCalls.filter(filterFunc)).length) {
          messages.push({
            role: 'assistant',
            content: agentResponse,
            tool_calls: this.#toolCalls.slice()
          })

          for (const tc of this.#toolCalls) {
            if (typeof window[tc.function?.name] === 'function') {
              const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : undefined
              
              try {
                const result = await window[tc.function.name](args)
                console.log(`Tool call executed: ${tc.function.name}`, args, result)

                messages.push({
                  role: 'tool',
                  content: JSON.stringify(result),
                  tool_call_id: tc.id
                })
              } catch (e) {
                console.error(`Tool call error: ${tc.function.name}`, args, e)
              }
            }
          }

          this.#toolCalls = []
          agentResponse += await this.#completionsCall({ messages, model })
        }

        if (!this.#cancelStreaming) {
          this.#onComplete?.(agentResponse, this.#getStatusString())
        }
      } catch (error) {
        if (!this.#cancelStreaming) {
          console.error('Error:', error)
          this.#onError?.(error)
        }
      } finally {
        this.stop()
      }
    }

    async #completionsCall({ messages, model, tools }) {
      let agentResponse = ''

      const response = await fetch(this.#apiUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.#apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: messages.map(m => ({
            role: m.role,
            content: this.#formatContent(m),
            tool_call_id: m.tool_call_id,
            tool_calls: m.tool_calls
          })),
          tools,
          stream: true,
          max_tokens: this.#max_tokens,
          temperature: this.#temperature
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let thinking = false

      while (true) {
        const { done, value } = await reader.read()
        if (done || this.#cancelStreaming) break

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
                agentResponse += delta.content
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
      
      this.#throttleAppendToken('\n ')
      return agentResponse + '\n '
    }

    #formatContent(message) {
      if (!message.files?.length) return message.content
      
      return `${message.content}\n\n${message.files.length} file(s) are attached for context:\n${
        message.files.map((f, i) => `[File ${i + 1}: ${f.name}]:\n${f.text}`).join('\n\n')
      }`
    }

    #throttleAppendToken(token) {
      const now = Date.now()
      const timeSinceLastCall = now - this.#lastThrottleTime
      this.#queuedTokens += token || ''

      if (timeSinceLastCall < 80) {
        this.#throttleTimeout = setTimeout(() => this.#throttleAppendToken(), timeSinceLastCall)
        return
      }

      clearTimeout(this.#throttleTimeout)
      this.#onToken?.(this.#queuedTokens)
      this.#queuedTokens = ''
      this.#lastThrottleTime = now
    }

    #getStatusString() {
      const wait = ((this.#startGeneration || new Date()).getTime() - this.#startWaiting.getTime()) / 1000
      const parts = []
      
      if (this.#tokenAmount > 0) {
        const sec = (new Date().getTime() - this.#startGeneration.getTime()) / 1000
        parts.push(this.#formatDuration(wait + sec))
        parts.push((this.#tokenAmount / sec).toFixed(2) + ' tok/s &#183; ' + this.#tokenAmount + ' token')
        parts.push(this.#formatDuration(wait) + ' to first token')
      } else if (this.#_isGenerating) {
        parts.push(this.#formatDuration(wait))
        parts.push('Waiting for first token ...')
      }
      
      parts.push(this.#generatingModel)
      return parts.join(' &#183; ')
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
        const cancelled = this.#cancelStreaming

        this.#cancelStreaming = true
        clearInterval(this.#statusInterval)

        this.#onToken = null
        this.#_isGenerating = false

        if (!cancelled) {
          this.#onEnd?.(true)
          this.#onEnd = null
        }

        setTimeout(resolve, 200)
      })
    }
  }

  return {
    createStream: function(options) {
      return new StreamController(options)
    }
  }
})() 
/* JL4 CONTRACT COMPUTATION EXTENSION
 * for https://github.com/serrynaimo/ai-chat
 * by Thomas Gorissen
 */
JL4_API = 'https://jl4.utility.workers.dev'

// REGISTER USER PROMPT MODES WITH THE UI
MODES = Object.assign({
  jl4_legal: {
    name: 'Legal assessment',
    visible: true,
    placeholder: 'What would you like to assess?',
    tools: ['legal_assessment'],
    hello: jl4_hello,
    initialMessages: () => [{
      role: 'system',
      content: `You're a lawyer AI and always use the provided \`legal_assessment\` tool call to, 1. Help you find out if you can help the user and, 2. assess a valid inquiry against the law. You then format the output into an information-dense, structured response and highlight the key findings in bold. Don't provide any explanation beyond the tool results and remind in the end that this is not yet actually legal advice.\nNow is ${new Date().toString()}`
    }]
  },
  jl4_find_function: {
    name: 'Finds a relevant function/contract',
    initialMessages: (inquiry, functions = []) => [{
      role: 'system',
      content: `You're a paralegal AI. You assess a user legal inquiry against a list of function descriptions of contracts. Return up to 3 names of functions if they are relevant to asses the inquiry. Always respond in the form of a valid JSON array containing the exact function names.`
    }, {
      role: 'user',
      content: `Assess if any of the following functions could be useful for this inquiry: "${inquiry}"\n\nFunctions: ${JSON.stringify(functions)}`
    }]
  },
  jl4_paralegal: {
    name: 'Paralegal. Evaluates the function/contract',
    initialMessages: (inquiry, toolname) => [{
      role: 'system',
      content: `You're a paralegal AI. You always call the provided \`${toolname}\` tool call with the exact right parameters to analyse contract situation of the legal inquiry. If you receive errors, try again if you have sufficient detail. Proceed to describe the results in form of bullet points. If you lack the required input detail to resolve errors, describe in detail what information you lack.`
    }, {
      role: 'user',
      content: `Call the provided tool correctly to evaluate the legal contract against this user inquiry: "${inquiry}"`
    }]
  }
}, MODES)


// ADD TOOL DEFINITION FOR THE MAIN LLM RUNNING THE USER PROMPT
TOOLS.unshift({
  type: "function", 
  function: {
      name: "legal_assessment",
      description: "Find out if and how you can help the user with their legal inquiry. If valid, assesses the inquiry against the law. Call only once.",
      parameters: {
          type: "object",
          properties: {
              inquiry: {
                  type: "string",
                  description: "All the latest details from the user inquiry inputs distilled from all user messages."
              }
          },
          required: ["inquiry"]
      }
  }
})


// TOOL FUNCTION EXECUTION
EXECUTE_TOOL.legal_assessment = async ({ inquiry }, id) => {
  if (!inquiry.trim()) {
      throw new Error('No inquiry passed')
  }

  let tools = []
  let answers = []

  try {
      if(!jl4_function_cache?.length) {
          await jl4_load_func_list()
      }
      const functionsJson = await chatStreams[id].call({
          id: id + '-' + (window.toolcount++),
          model: getDefaultModel(),
          messages: MODES.jl4_find_function.initialMessages(inquiry, jl4_function_cache)
      })
      tools = (JSON.parse(functionsJson.content?.match(/(\[(\s*"[^"]*"\s*,?)*\s*\])/)?.[0]) || [])
        .map(t => ({ i: window.toolcount++, name: t }))
      RENDER_TOOL.legal_assessment({ functions_used: tools }, id)
      
      for (const tool of tools) {
          const tid = id + '-' + tool.i
          let tdef = jl4_function_cache?.find(f => f.function.name === tool.name)
          if (!tdef?.function.parameters) {
              const jl4Response = await fetch(`${JL4_API}/functions/${tool.name}`)
              if (!jl4Response.ok) {
                  throw new Error('Failed to provide jl4 results') 
              }
              tdef = Object.assign(tdef, await jl4Response.json())
          }
          const toolJson = await chatStreams[id].call({
              id: tid,
              model: getDefaultModel(),
              messages: MODES.jl4_paralegal.initialMessages(inquiry, tool.name),
              tools: [tdef]
          })
          answers.push(toolJson.content)
          await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!tools.length) {
          answers.push('Not an area of our legal expertise.')
      }
  } catch (e) {
      answers.push('Legal assessment failed. Conflict of interest.')
      console.error('Legal assessment failed for ' + id, e)
  }

  return { id, answers, functions_used: tools }
}

// RENDER TOOL RESULT IN CHAT MESSAGE STREAM using `appendTool({ html, id })`
RENDER_TOOL.legal_assessment = (results, id) => {
  const parts = id.split('-')
  if (loadedChatId?.toString() === parts[0] && results.functions_used?.length) {
    appendTool({ html: `<p>Doing law ...</p><ol>${results.functions_used.map(t => `<li><strong>Reviewing possibly relevant legal context: <code>${t.name}</code></strong><br><div id='${id + '-' + t.i}' class="subcontent"></div></li>`).join('')}</ol>`, id })
  }
}

// HANDLE THE TOOL CALL EXECUTION OF FUNCTIONS IN jl4_function_cache
async function jl4_eval_func (func, args, id) {
  // Use jl4 for legal assessment
  if(!window.jl4_function_cache?.find(f => f.function.name === func)) {
      throw Error('Not a valid tool call')
  }

  appendTool({ html: `<p>Evaluating contract</p><ul class='items'>${Object.keys(args)?.map(k => `<li>${k}: <code>${args[k]}</code></li>`).join('')}</ul>`, id })

  const response = await fetch(`${JL4_API}/functions/${func}/evaluation`, {
      method: 'POST',
      headers: {
          'Content-type': 'application/json'
      },
      body: JSON.stringify({
          fnArguments: args,
          fnEvalBackend: 'jl4'
      })
  })
  if (!response.ok) {
      throw Error('Failed to evaluate jl4 function')
  }
  const result = await response.json()
  if (!result.tag.match(/Error/i)) {
      appendTool({ html: `<p>Para-legal says</p><ul class='items'>${result.contents.values?.map(v => `<li>${v[0]}: <code>${v[1]}</code></li>`).join('')}</ul>`, id })
  }
  return result.contents
}

async function jl4_hello () {
  if (!document.body.classList.contains('new')) return
  clearMemory()
  await jl4_load_func_list()
  await appendMessage({ text: `<p>The following contracts are available: ${jl4_function_cache.map(f => `<code style='cursor: pointer;' onclick='jl4_render_func("${f.function.name}")'>${f.function.name}</code>`).join(', ')}</p>`, sender: 'assistant' })
}

async function jl4_render_func (name) {
  if (document.body.classList.contains('generating')) return
  clearMemory()
  document.body.classList.remove('new')
  let tdef = jl4_function_cache?.find(f => f.function.name === name)
  if (!tdef?.function.parameters) {
      const jl4Response = await fetch(`${JL4_API}/functions/${name}`)
      if (!jl4Response.ok) {
          throw new Error('Failed to provide jl4 results') 
      }
      tdef = Object.assign(tdef, await jl4Response.json())
  }
  const props = tdef.function.parameters.properties || {}
  const reqs = tdef.function.parameters.required || []
  await appendMessage({ text: `<strong>Description for <code>${tdef.function.name}</code></strong><p>${tdef.function.description}</p><ul>${Object.keys(props).map(k => `<li><code${reqs?.includes(k) ? ` style='text-decoration: underline;'` : ''}>${k}</code><i>${props[k].type}</i>: ${props[k].description}</li>`).join('')}</ul>`, sender: 'assistant', id: loadedChatId})
}

// ONLOAD UPDATE FUNCTION CACHE
async function jl4_load_func_list () {
  const response = await fetch(`${JL4_API}/functions`)
  if (!response.ok) {
    throw new Error('Failed to load jl4 functions results') 
  }       
  jl4_function_cache = await response.json()
  jl4_function_cache.forEach(f => {
    EXECUTE_TOOL[f.function.name] = jl4_eval_func.bind(window, f.function.name)
  })
}

// GLOBAL VARIABLES FOR THIS EXTENSION
window.jl4_function_cache = []

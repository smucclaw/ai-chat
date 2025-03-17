/* JL4 CONTRACT COMPUTATION EXTENSION
 * for https://github.com/serrynaimo/ai-chat
 * by Thomas Gorissen
 */
JL4_API = 'https://jl4.utility.workers.dev/decision'

// REGISTER USER PROMPT MODES WITH THE UI
MODES = Object.assign({
  jl4_legal: {
    name: 'Legal assessment',
    visible: true,
    placeholder: 'What would you like to assess?',
    tools: ['legal_assessment', 'list_functions_available'],
    initialMessages: () => [{
      role: 'system',
      content: `You're a lawyer AI and always use the provided \`list_functions_available\` or \`legal_assessment\` tool call to, 1. Help you find out if you can help the user and, 2. assess a valid inquiry against the law. You then format the output into an information-dense, structured response and highlight the key findings in bold. Don't provide any explanation beyond the tool results and remind in the end that this is not yet actually legal advice.\nNow is ${new Date().toString()}`
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
      name: "list_functions_available",
      description: "List all available functions or contracts",
      parameters: {
          type: "object",
          properties: {},
          required: []
      }
  }
}, {
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
EXECUTE_TOOL.list_functions_available = async (id) => {
  try {
    if(!jl4_function_cache?.length) {
        await loadFunctions()
    }
  } catch (e) {
    console.error('Loading available functions/contracts failed' + id, e)
  }

  return { id, functions_available: jl4_function_cache?.map(m => m.function) || [] }
}

EXECUTE_TOOL.legal_assessment = async ({ inquiry }, id) => {
  if (!inquiry.trim()) {
      throw new Error('No inquiry passed')
  }

  let tools = []
  let answers = []

  try {
      if(!jl4_function_cache?.length) {
          await loadFunctions()
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
              tdef = await jl4Response.json()
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
    appendTool({ html: `<p>Doing law ...</p><ol>${results.functions_used.map(t => `<li><strong>Reviewing possibly relevant legal context: <code>${t.name}</code></strong><br><div id='${id + '-' + t.i}' class="subcontent"></div></li>`).join('')}</ol>` })
  }
}

// HANDLE THE TOOL CALL EXECUTION OF FUNCTIONS IN jl4_function_cache
async function evaluateFunction (func, args, id) {
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

// ONLOAD UPDATE FUNCTION CACHE
async function loadFunctions () {
  if (new URLSearchParams(window.location.search).get('jl4_mock')) {
    window.jl4_mock = true
  }
  if (!window.jl4_mock) {
    const response = await fetch(`${JL4_API}/functions`)
    if (!response.ok) {
      throw new Error('Failed to load jl4 functions results') 
    }       
    jl4_function_cache = await response.json()
  }
  jl4_function_cache.forEach(f => {
    EXECUTE_TOOL[f.function.name] = evaluateFunction.bind(window, f.function.name)
  })
}

// TEMPORARY GLOBAL VARIABLES FOR THIS EXTENSION
window.jl4_function_cache = [{
  function: {
    description: "Determines if a person qualifies for being human.\nThe input object describes the person's properties in the primary parameters: walks, eats, drinks.\nSecondary parameters can be given which are sufficient to determine some of the primary parameters.\nA person drinks whether or not they consume an alcoholic or a non-alcoholic beverage, in part or in whole;\nthose specific details don't really matter.\nThe output of the function can be either a request for required information;\na restatement of the user input requesting confirmation prior to function calling;\nor a Boolean answer with optional explanation summary.",
    name: "compute_qualifies",
    parameters: {
        properties: {
          "drinks": {
            "alias": null,
            "description": "Did the person drink?",
            "enum": ["true", "false"],
            "type": "string"
          },
          "eats": {
            "alias": null,
            "description": "Did the person eat?",
            "enum": ["true", "false"],
            "type": "string"
          },
          "walks": {
            "alias": null,
            "description": "Did the person walk?",
            "enum": ["true", "false"],
            "type": "string"
          }
        },
        required: [
          "drinks",
          "eats",
          "walks"
        ],
        type: "object",
      },
      supportedBackends: []
  },
  type: "function"
}, {
  function: {
    description: "Assesses household insurance case viability based on who damaged it (e.g. human or type of animal), and impact of damage (e.g. to furnitue, household appliance, swimming pool or plumbing, heating or air conditioning system)",
    name: "vermin_and_rodent",
    parameters: {
      properties: {
        "Loss or Damage.caused by birds": {
          "alias": null,
          "description": "Was the damage caused by birds?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "Loss or Damage.caused by insects": {
          "alias": null,
          "description": "Was the damage caused by insects?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "Loss or Damage.caused by rodents": {
          "alias": null,
          "description": "Was the damage caused by rodents?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "Loss or Damage.caused by vermin": {
          "alias": null,
          "description": "Was the damage caused by vermin?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "Loss or Damage.ensuing covered loss": {
          "alias": null,
          "description": "Is the damage ensuing covered loss",
          "enum": ["true", "false"],
          "type": "string"
        },
        "Loss or Damage.to Contents": {
          "alias": null,
          "description": "Is the damage to your contents?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "a household appliance": {
          "alias": null,
          "description": "Did water escape from a household appliance due to an animal?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "a plumbing, heating, or air conditioning system": {
          "alias": null,
          "description": "Did water escape from a plumbing, heating or conditioning system due to an animal?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "a swimming pool": {
          "alias": null,
          "description": "Did water escape from a swimming pool due to an animal?",
          "enum": ["true", "false"],
          "type": "string"
        },
        "any other exclusion applies": {
          "alias": null,
          "description": "Are any other exclusions besides mentioned ones?",
          "enum": ["true", "false"],
          "type": "string"
        }
      },
      required: [
        "Loss or Damage.caused by birds",
        "Loss or Damage.caused by insects",
        "Loss or Damage.caused by rodents",
        "Loss or Damage.caused by vermin",
        "Loss or Damage.ensuing covered loss",
        "Loss or Damage.to Contents",
        "a household appliance",
        "a plumbing, heating, or air conditioning system",
        "a swimming pool",
        "any other exclusion applies"
      ],
      type: "object"
    },
    supportedBackends: []
  },
  type: "function"
}]

loadFunctions()

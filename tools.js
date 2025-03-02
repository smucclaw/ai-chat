const TOOLS = [{
  type: "function", 
  function: {
      name: "search_web",
      description: "Search the web for current information about a precise topic. Only use when asked about current events or specific information that need verification. Only use once.",
      parameters: {
          type: "object",
          properties: {
              query: {
                  type: "string",
                  description: "The search query or keywords"
              }
          },
          required: ["query"]
      }
  }
}, {
  type: "function",
  function: {
      name: "search_user_history",
      description: "Retrieve the conversation history with the user by single key words. Use it to personalise or to find additional context from the past",
      parameters: {
          type: "object",
          properties: {
              keywords: {
                  type: "array",
                  items: {
                      type: "string"
                  },
                  description: "Key words to look for. Singular and plural matters."
              }
          }
      },
  }
}, {
  type: "function",
  function: {
      name: "spawn_research_agents",
      description: "Research in detail with the most recent and accurate information. Only use once!",
      parameters: {
          type: "object",
          properties: {
              context: {
                  type: "string",
                  description: "A short summary of the user prompt and relevant user context"
              },
              key_topic: {
                  type: "string",
                  description: "The most important key topic you require to understand in detail to give a good answer."
              },
              helpful_topic: {
                  type: "string",
                  description: "Another important or helpful set of information or a different angle on the question you need up-to-date and relevant information on"
              },
              approach: {
                  type: "string",
                  description: "A helpful approach or method that you want to understand better to evaluate the other information"
              },
              challange: {
                  type: "string",
                  description: "A prompt that challenges your current assumptions to see if they hold up"
              }
          },
          required: ["context", "key_topic", "challenge"]
      }
  }
}, {
  type: "function",
  function: {
      name: "get_weather",
      description: "Retrieve the current or 7-day forecasted weather information at a specific latitude and longitude, only if asked",
      parameters: {
          type: "object",
          properties: {
              latitude: {
                  type: "number",
                  description: "The exact latitude of the location on planet earth"
              },
              longitude: {
                  type: "number",
                  description: 'The exact longitude of the location on planet earth'
              },
              temp_unit: {
                  type: "string",
                  description: "Unit the temperature will be returned in",
                  enum: ['fahrenheit', 'celsius']
              },
              speed_unit: {
                  type: "string",
                  description: "Unit the wind speed will be returned in",
                  enum: ['kmh', 'mph']
              },
              forecast: {
                  type: "boolean",
                  description: "False returns the current weather. True the 7-day forecast."
              }
          },
          required: ["latitude", "longitude", "forecast"]
      },
  }
}]



// TOOL FUNCTIONS
async function search_web({ query }, id) {
  if (!query.trim()) {
      throw new Error('No query or keywords passed')
  }
  const response = await fetch(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CUSTOMSEARCH_API_KEY}&cx=${GOOGLE_CUSTOMSEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}`)
  if (response.status === 403) {
      return { error: 'Please tell the user that they have not set up their Google Custom Search key in the source code, yet.' }
  } else if (response.status === 429) {
      return { error: 'Please tell the user that we have made too many requests for the day.'}
  } else if (!response.ok) {
      throw new Error('Failed to provide search results') 
  }
  const data = await response.json()  
  const results = { id, query, results: data.items.map(i => ({ title: i.title, snippet: i.snippet, url: i.link })) }
  render_search_web(results, id)
  return results
}

async function get_weather({ latitude, longitude, speed_unit = 'kmh', temp_unit = 'celsius', forecast = true }, id) {
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
      + (forecast
          ? '&daily=temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,weather_code,wind_speed_10m_max,wind_direction_10m_dominant&forecast_days=7'
          : '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m')
      + `&wind_speed_unit=${speed_unit}&temperature_unit=${temp_unit}`)
  const data = await response.json()
  
  const weatherCodes = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail' }

  if (!forecast) {
      data.current.conditions = weatherCodes[data.current.weather_code] || 'Unknown'
      const results = { id, now: new Date().toString(), current: data.current }
      render_get_weather(results, id)
      return results
  }

  const days = data.daily.time.map((date, index) => {
      return Object.keys(data.daily).reduce((acc, key) => {
          acc[key === 'time' ? 'date' : key] = data.daily[key][index]
          return acc
      }, { day: new Date(date).toLocaleString(undefined, { weekday: 'short', timeZone: 'UTC' }), conditions: weatherCodes[data.daily.weather_code[index]] || 'Unknown' })
  });

  const results = { id, now: new Date().toString(), forecast: days }
  render_get_weather(results, id)
  return results
}

async function search_user_history({ keywords }, id) {
  list = typeof keywords === 'object' ? keywords.map(k => k.toLowerCase()) : [keywords.toString().toLowerCase()]
  const history = (JSON.parse(localStorage.getItem('history')) || []).filter(h => h.id !== loadedChatId)
  const matching = history.filter(h => list.find(k => h.log[0].content.toLowerCase().includes(k.trim())))
  const logs = (matching?.length ? matching : history).slice(0, 3).map(h => h.log)
  const results = {
      id,
      description: 'The logs array contains the ' + (matching?.length ? `${matching.length} previous conversations matching the keywords "${keywords}"` : `latest ${logs.length} conversations`) + ' of ' + history.length + ' total past conversations with this user.',
      logs
  }
  render_search_user_history(results, id)
  return results
}

async function spawn_research_agents(topics, id) {
  const context = topics.context?.trim()
  let i = 1
  topics = Object.keys(topics).reduce((a, v) => v !== 'context' && topics[v]?.trim() ? [...a, { i: i++, topic: topics[v] }] : a, [])
  if (!topics?.length || !context) {
      throw new Error('No topic to research specified')
  }
  const addedSteps = [{ i, topic: 'Verifying results and synthesizing ...' }]
  render_spawn_research_agents({ topics: [...topics, ...addedSteps] }, id)
  await Promise.all(topics.map(async topic => {
      try {
          await new Promise(resolve => setTimeout(resolve, 250))
          const json = await chatStreams[id].call({
              id: id + '-' + topic.i,
              messages: MODES.researchAgent.initialMessages(topic.topic, context),
              tools: TOOLS.filter(t => MODES.researchAgent.tools.includes(t.function.name))
          })
          topic.result = json.content?.replace(/<think>[\s\S]*<\/think>/g, '') || 'No information found'
      } catch (e) {
          console.error('Could not research topic for ' + id, topic, e)
      }
  }))
  await Promise.all(addedSteps.map(async step => {
      try {
          await new Promise(resolve => setTimeout(resolve, 250))
          const json = await chatStreams[id].call({
              id: id + '-' + step.i,
              messages: MODES.verify.initialMessages(context, topics.map(t => t.result).join('\n\n')),
              tools: TOOLS.filter(t => MODES.verify.tools.includes(t.function.name))
          })
          step.result = json.content?.replace(/<think>[\s\S]*<\/think>/g, '') || 'No information found'
      } catch (e) {
          console.error('Could not research step for ' + id, step, e)
      }
  }))
  return { id, topics: [...topics, ...addedSteps]  }
}
// TOOL FUNCTIONS END



// TOOL RESULT FUNCTIONS
async function render_search_web(results, id) {
  const parts = id.split('-')
  if (loadedChatId.toString() === parts[0] && results.id) {
      id = loadedChatId + '-' + (parts[1] || results.id.split('-')[1])
      appendTool({ html: `<p>Web search: ${results.query}</p><ul class="items">${results.results.slice(0, 5).map(r => `<li><img src="${new URL(r.url).origin}/favicon.png" onerror="faviconError(this)" /><a href="${r.url}" rel="noopener nofollow noreferrer" target="_blank" title="${r.title.replace(/"/, '\"')}">${new URL(r.url).hostname.replace('www.','')}</a></li>`).join('')}${results.results.length > 5 ? `<li><span>... ${results.results.length - 5} more</span></li>` : ''}</ul>`, id })
  }
}
async function render_get_weather(results, id) {
  const parts = id.split('-')
  if (loadedChatId.toString() === parts[0] && results.id) {
      id = loadedChatId + '-' + (parts[1] || results.id.split('-')[1])
      appendTool({ html: '<p>' + (results.forecast ? 'Checking the 7-day weather forecast ...' : 'Checking today\'s weather ...') + '</p>', id })
  }
}

async function render_search_user_history(results, id) {
  const parts = id.split('-')
  if (loadedChatId.toString() === parts[0] && results.id) {
      const content = results.logs.map(r => {
          const html = r[0].content.replace(/</g, '&lt;').replace(/>/g, '&gt;')
          return `<li><span title="${r[0].content.replace(/"/g, '\"')}">"${html}"</span></li>`
      })
      id = loadedChatId + '-' + (parts[1] || results.id.split('-')[1])
      appendTool({ html: `<p>Reviewing chat history:</p><ul class="items">${content.join('')}</ul>`, id })
  }
}

async function render_spawn_research_agents(results, id) {
  const parts = id.split('-')
  if (loadedChatId.toString() === parts[0]) {
      appendTool({ html: `<p>Researching ...</p><ol>${results.topics.map(t => `<li><strong>${t.topic}</strong><br><div id='${id + '-' + t.i}' class="subcontent"></div></li>`).join('')}</ol>` })
  }
}
// TOOL RESULT FUNCTIONS END

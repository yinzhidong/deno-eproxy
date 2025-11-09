import { Buffer } from "node:buffer";

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://api.x.ai";
const API_VERSION = "v1";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "grok-proxy/0.1.0"; // 修改为我们自己的标识

const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "Authorization": `Bearer ${apiKey}` }),
  ...more
});

async function handleModels(apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-002";
async function handleEmbeddings(req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  if (!Array.isArray(req.input)) {
    req.input = [req.input];
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model.substring(7);
  } else {
    req.model = DEFAULT_EMBEDDINGS_MODEL;
    model = req.model;
  }

  const response = await fetch(`${BASE_URL}/${API_VERSION}/embeddings`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "model": model,
      "input": req.input,
      "dimensions": req.dimensions
    })
  });

  return new Response(await response.text(), fixCors(response));
}

const DEFAULT_MODEL = "grok-beta";
async function handleCompletions(req, apiKey) {
  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("grok-"):
      model = req.model;
  }

  // Grok API 使用标准的 chat/completions 端点
  const url = `${BASE_URL}/${API_VERSION}/chat/completions`;

  // 确保流式参数被正确传递
  const requestBody = { ...req };

  // 显式设置stream参数
  if (req.stream) {
    requestBody.stream = true;
  }

  console.log("Request Body:", JSON.stringify(requestBody));

  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    // 如果响应不成功，直接返回错误信息
    console.error("API Response Error:", await response.text());
    return new Response(await response.text(), fixCors(response));
  }

  let body = response.body;
  const id = generateChatcmplId();

  if (req.stream) {
    // 处理流式响应
    console.log("处理流式响应");
    body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({
        transform: parseStream,
        flush: parseStreamFlush,
        buffer: "",
      }))
      .pipeThrough(new TransformStream({
        transform: toOpenAiStream,
        flush: toOpenAiStreamFlush,
        streamIncludeUsage: req.stream_options?.include_usage,
        model, id, last: [],
      }))
      .pipeThrough(new TextEncoderStream());
  } else {
    // 处理非流式响应
    console.log("处理非流式响应");
    const responseText = await response.text();
    console.log("API响应内容:", responseText.substring(0, 500) + (responseText.length > 500 ? "..." : ""));
    
    try {
      const responseData = JSON.parse(responseText);
      body = processCompletionsResponse(responseData, model, id);
      return new Response(body, fixCors(response));
    } catch (err) {
      console.error("Error parsing response:", err);
      return new Response(responseText, fixCors(response));
    }
  }

  return new Response(body, fixCors(response));
}

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // not for streaming
  max_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK", // non-standard
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new Error("Invalid image data: " + url);
    }
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({ role, content }) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({ text: content });
    return { role, parts };
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return { role, parts };
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    if (item.role === "system") {
      delete item.role;
      system_instruction = await transformMsg(item);
    } else {
      item.role = item.role === "assistant" ? "model" : "user";
      contents.push(await transformMsg(item));
    }
  }
  if (system_instruction && contents.length === 0) {
    contents.push({ role: "model", parts: { text: " " } });
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
});

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({ length: 29 }, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
  // :"function_call",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => {
  // 适配Grok API的响应格式
  if (cand.message) {
    // 如果已经是OpenAI格式，直接返回
    return {
      index: cand.index || 0,
      [key]: cand.message,
      logprobs: null,
      finish_reason: cand.finish_reason || "stop"
    };
  }

  // 兼容原Gemini格式
  return {
    index: cand.index || 0,
    [key]: {
      role: "assistant",
      content: cand.content?.parts?.map(p => p.text).join(SEP) || cand.content
    },
    logprobs: null,
    finish_reason: reasonsMap[cand.finishReason] || cand.finishReason || "stop",
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

const transformUsage = (data) => {
  if (!data) return null;
  // 如果已经是OpenAI格式
  if (data.prompt_tokens) {
    return data;
  }

  // 兼容原Gemini格式
  return {
    completion_tokens: data.candidatesTokenCount || data.completion_tokens || 0,
    prompt_tokens: data.promptTokenCount || data.prompt_tokens || 0,
    total_tokens: data.totalTokenCount || data.total_tokens || 0
  };
};

const processCompletionsResponse = (data, model, id) => {
  // 如果响应已经是OpenAI格式
  if (data.choices) {
    return JSON.stringify({
      ...data,
      id: id || data.id,
      model: model || data.model,
      object: data.object || "chat.completion"
    });
  }

  // 处理Gemini格式
  return JSON.stringify({
    id,
    choices: (data.candidates || []).map(transformCandidatesMessage),
    created: Math.floor(Date.now() / 1000),
    model,
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata || data.usage),
  });
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
async function parseStream(chunk, controller) {
  chunk = await chunk;
  if (!chunk) { return; }

  // 特殊处理[DONE]消息
  if (chunk.includes('data: [DONE]')) {
    controller.enqueue('data: [DONE]');
    return;
  }

  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}

async function parseStreamFlush(controller) {
  if (this.buffer) {
    if (this.buffer.includes('[DONE]')) {
      controller.enqueue('data: [DONE]');
    } else {
      console.error("Invalid data:", this.buffer);
      controller.enqueue(this.buffer);
    }
    this.buffer = '';
  }
}

function transformResponseStream(data, stop, first) {
  // 如果数据已经是OpenAI流式格式
  if (data.choices && data.choices[0]?.delta) {
    const output = {
      ...data,
      id: this.id || data.id,
      model: this.model || data.model,
      object: data.object || "chat.completion.chunk",
    };
    return "data: " + JSON.stringify(output) + delimiter;
  }

  // 处理原Gemini格式
  const item = transformCandidatesDelta(data.candidates ? data.candidates[0] : data);
  if (stop) { item.delta = {}; } else { item.finish_reason = null; }
  if (first) { item.delta.content = ""; } else { delete item.delta.role; }

  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now() / 1000),
    model: this.model,
    object: "chat.completion.chunk",
  };

  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = stop ? transformUsage(data.usageMetadata) : null;
  }

  return "data: " + JSON.stringify(output) + delimiter;
}

const delimiter = "\n\n";

async function toOpenAiStream(chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;

  if (!line) { return; }

  // 特殊处理[DONE]消息
  if (line === 'data: [DONE]') {
    controller.enqueue("data: [DONE]" + delimiter);
    return;
  }

  let data;
  try {
    data = JSON.parse(line);

    // 判断是否已经是OpenAI格式
    if (data.choices && Array.isArray(data.choices)) {
      controller.enqueue("data: " + line + delimiter);
      return;
    }

  } catch (err) {
    console.error("Error parsing stream data:", line);
    console.error(err);

    // 尝试直接传递数据
    controller.enqueue("data: " + line + delimiter);
    return;
  }

  try {
    // 处理Gemini格式
    const cand = data.candidates?.[0] || data;
    const index = cand.index || 0;

    if (!this.last[index]) {
      controller.enqueue(transform(data, false, "first"));
    }

    this.last[index] = data;

    if (cand.content) {
      controller.enqueue(transform(data));
    }
  } catch (err) {
    console.error("Error handling stream data:", err);
    // 尝试直接传递数据
    controller.enqueue("data: " + line + delimiter);
  }
}

async function toOpenAiStreamFlush(controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last && this.last.length > 0) {
    for (const data of this.last) {
      if (data) {
        controller.enqueue(transform(data, "stop"));
      }
    }
  }
  // 确保发送结束标记
  controller.enqueue("data: [DONE]" + delimiter);
}


const errHandler = (err) => {
  console.error(err);
  return new Response(err.message, fixCors({ status: err.status ?? 500 }));
};

const assert = (success) => {
  if (!success) {
    throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
  }
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }

    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];

      const { pathname } = new URL(request.url);
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey).catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey).catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey).catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

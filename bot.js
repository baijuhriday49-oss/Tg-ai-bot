require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── MODELS ──────────────────────────────────────────────

const IMAGE_MODELS = {
  flux:     { label: 'Flux',      desc: 'Best quality (default)' },
  turbo:    { label: 'Turbo',     desc: 'Fastest generation' },
  gptimage: { label: 'GPT Image', desc: 'OpenAI image model' },
  seedream: { label: 'Seedream',  desc: 'Dreamlike style' },
  kontext:  { label: 'Kontext',   desc: 'Context-aware gen' },
};

const TEXT_MODELS = {
  openai:   { label: 'GPT-5',    desc: 'OpenAI GPT-5' },
  claude:   { label: 'Claude',   desc: 'Anthropic Claude' },
  gemini:   { label: 'Gemini',   desc: 'Google Gemini' },
  deepseek: { label: 'DeepSeek', desc: 'DeepSeek V3.2' },
  qwen:     { label: 'Qwen',     desc: 'Qwen3' },
};

const VISION_MODEL  = 'meta-llama/llama-4-scout-17b-16e-instruct';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3';

// ─── USER STATE ──────────────────────────────────────────

const userState = {};

function getState(userId) {
  if (!userState[userId]) {
    userState[userId] = { imageModel: 'flux', textModel: 'openai', history: [] };
  }
  return userState[userId];
}

function addToHistory(userId, role, content) {
  const state = getState(userId);
  state.history.push({ role, content });
  if (state.history.length > 20) state.history.splice(0, state.history.length - 20);
}

// ─── SYSTEM PROMPT ───────────────────────────────────────

const SYSTEM_PROMPT = `You are a chill, casual AI friend on Telegram named Hridayai. Chat naturally like a real person — short messages, relaxed tone, use words like "yeah", "hmm", "totally", "lol", "ngl" when it fits. Warm, witty, never robotic. Keep replies SHORT and punchy. Emojis occasionally but don't overdo it.`;

// ─── POLLINATIONS TEXT (free, no key) ────────────────────

function pollinationsChat(model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature: 0.85, max_tokens: 200 });
    const req = https.request({
      hostname: 'text.pollinations.ai',
      path: '/openai',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const reply = json.choices?.[0]?.message?.content?.trim();
          if (reply) resolve(reply);
          else reject(new Error('Empty response from Pollinations'));
        } catch (e) {
          reject(new Error('Pollinations parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Pollinations timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── GROQ TEXT FALLBACK ───────────────────────────────────

async function groqChat(messages) {
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages,
    max_tokens: 200,
    temperature: 0.85,
  });
  return completion.choices[0]?.message?.content?.trim() || "lol idk 😅";
}

// ─── MAIN CHAT FUNCTION ───────────────────────────────────

async function askAI(userId, userMessage) {
  const state = getState(userId);
  addToHistory(userId, 'user', userMessage);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...state.history,
  ];

  let reply;
  try {
    // Try Pollinations first
    reply = await pollinationsChat(state.textModel, messages);
    console.log(`💬 [${userId}] [pollinations:${state.textModel}]`);
  } catch (err) {
    // Fallback to Groq
    console.warn(`⚠️ Pollinations failed (${err.message}), falling back to Groq`);
    reply = await groqChat(messages);
    console.log(`💬 [${userId}] [groq:fallback]`);
  }

  addToHistory(userId, 'assistant', reply);
  return reply;
}

// ─── GROQ VISION (Llama 4 Scout) ─────────────────────────

async function analyzeImage(imageBase64, caption) {
  const userText = caption
    ? caption
    : "What's in this image? Describe it casually like a friend, keep it short.";

  const completion = await groq.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      },
    ],
    max_tokens: 300,
    temperature: 0.8,
  });

  return completion.choices?.[0]?.message?.content?.trim() || "hmm couldn't read that image 😅";
}

// ─── GROQ WHISPER ─────────────────────────────────────────

async function transcribeVoice(filePath) {
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: WHISPER_MODEL,
    language: 'en',
  });
  return transcription.text?.trim() || '';
}

// ─── POLLINATIONS IMAGE GEN ───────────────────────────────

async function generateImage(prompt, model, outputPath) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?model=${model}&width=1024&height=1024&nologo=true&enhance=true`;
  await downloadFile(url, outputPath);
}

// ─── GOOGLE TTS ───────────────────────────────────────────

async function textToSpeech(text, outputPath) {
  const encoded = encodeURIComponent(text.slice(0, 200));
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en&client=tw-ob`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

// ─── HELPERS ─────────────────────────────────────────────

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = fileUrl.startsWith('https') ? https : http;
    client.get(fileUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

function convertOggToMp3(inputPath, outputPath) {
  execSync(`ffmpeg -y -i "${inputPath}" "${outputPath}" 2>/dev/null`);
}

async function getTelegramFileBase64(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  const tmpPath = path.join('/tmp', `photo_${Date.now()}.jpg`);
  await downloadFile(fileUrl, tmpPath);
  const base64 = fs.readFileSync(tmpPath).toString('base64');
  fs.unlink(tmpPath, () => {});
  return base64;
}

function buildModelMenu(state) {
  let msg = `🎛 *Model Settings*\n\n`;
  msg += `*🎨 Image Model:* ${IMAGE_MODELS[state.imageModel]?.label}\n`;
  Object.entries(IMAGE_MODELS).forEach(([key, val]) => {
    msg += `${key === state.imageModel ? '✅' : '▫️'} \`/imgmodel ${key}\` — ${val.label} · ${val.desc}\n`;
  });
  msg += `\n*🧠 Chat Brain:* ${TEXT_MODELS[state.textModel]?.label}\n`;
  Object.entries(TEXT_MODELS).forEach(([key, val]) => {
    msg += `${key === state.textModel ? '✅' : '▫️'} \`/chatmodel ${key}\` — ${val.label} · ${val.desc}\n`;
  });
  msg += `\n*👁 Vision:* Llama 4 Scout · Groq\n`;
  msg += `*🎤 STT:* Whisper Large v3 · Groq\n`;
  msg += `*🔊 TTS:* Google Translate · Free\n`;
  return msg;
}

// ─── COMMANDS ────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'friend';
  bot.sendMessage(msg.chat.id,
    `hey ${name}! 👋 I'm *Hridayai* — your chill AI friend\\.\n\n` +
    `💬 text me anything → chat\n` +
    `🎤 voice note → voice reply\n` +
    `📸 send a photo → I'll see it\n` +
    `🎨 /imagine \\<prompt\\> → gen image\n` +
    `🎛 /models → switch AI models\n` +
    `🧹 /clear → reset chat\n` +
    `ℹ️ /help → all commands\n\n` +
    `let's vibe\\! 😎🔥`
  , { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*All Commands:*\n\n` +
    `💬 type anything → chat\n` +
    `🎤 voice note → voice reply\n` +
    `📸 send photo → AI sees it\n` +
    `📸\\+caption → ask a question about it\n` +
    `🎨 /imagine \\<prompt\\> → generate image\n` +
    `🎛 /models → view & switch models\n` +
    `🖼 /imgmodel \\<name\\> → set image model\n` +
    `🧠 /chatmodel \\<name\\> → set chat brain\n` +
    `🧹 /clear → fresh start\n` +
    `ℹ️ /help → this menu`
  , { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/clear/, (msg) => {
  getState(msg.from.id).history = [];
  bot.sendMessage(msg.chat.id, 'done\\! fresh start 🧹', { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/models/, (msg) => {
  bot.sendMessage(msg.chat.id, buildModelMenu(getState(msg.from.id)), { parse_mode: 'Markdown' });
});

bot.onText(/\/imgmodel(?:\s+(.+))?/, (msg, match) => {
  const key = (match[1] || '').trim().toLowerCase();
  if (!key || !IMAGE_MODELS[key]) {
    bot.sendMessage(msg.chat.id,
      `Available image models:\n${Object.keys(IMAGE_MODELS).map(k => `• \`/imgmodel ${k}\` — ${IMAGE_MODELS[k].label}`).join('\n')}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  getState(msg.from.id).imageModel = key;
  bot.sendMessage(msg.chat.id, `🎨 Image model → *${IMAGE_MODELS[key].label}* ✅`, { parse_mode: 'Markdown' });
});

bot.onText(/\/chatmodel(?:\s+(.+))?/, (msg, match) => {
  const key = (match[1] || '').trim().toLowerCase();
  if (!key || !TEXT_MODELS[key]) {
    bot.sendMessage(msg.chat.id,
      `Available chat models:\n${Object.keys(TEXT_MODELS).map(k => `• \`/chatmodel ${k}\` — ${TEXT_MODELS[k].label}`).join('\n')}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const state = getState(msg.from.id);
  state.textModel = key;
  state.history = [];
  bot.sendMessage(msg.chat.id, `🧠 Chat brain → *${TEXT_MODELS[key].label}* ✅\n_history cleared_`, { parse_mode: 'Markdown' });
});

bot.onText(/\/imagine(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const prompt = (match[1] || '').trim();

  if (!prompt) {
    bot.sendMessage(chatId, 'Give me a prompt! e.g. `/imagine a dragon on a mountain`', { parse_mode: 'Markdown' });
    return;
  }

  const state = getState(userId);
  const modelLabel = IMAGE_MODELS[state.imageModel]?.label || state.imageModel;

  try {
    await bot.sendChatAction(chatId, 'upload_photo');
    await bot.sendMessage(chatId, `🎨 Generating with *${modelLabel}*...\n_"${prompt}"_`, { parse_mode: 'Markdown' });

    const imgPath = path.join('/tmp', `img_${userId}_${Date.now()}.jpg`);
    await generateImage(prompt, state.imageModel, imgPath);

    await bot.sendPhoto(chatId, fs.createReadStream(imgPath), {
      caption: `🎨 _"${prompt}"_\n🤖 *${modelLabel}* · ✨ Pollinations.ai`,
      parse_mode: 'Markdown',
    });

    fs.unlink(imgPath, () => {});
    console.log(`🎨 [${userId}] [${state.imageModel}] "${prompt}"`);
  } catch (err) {
    console.error('Image error:', err.message);
    bot.sendMessage(chatId, 'Image gen glitched 😬 Try a different prompt?');
  }
});

// ─── MESSAGE HANDLERS ────────────────────────────────────

// 📸 Photo → Vision
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const caption = msg.caption || null;

  try {
    await bot.sendChatAction(chatId, 'typing');
    await bot.sendMessage(chatId, '👁 _Looking at your photo..._', { parse_mode: 'Markdown' });

    const photo = msg.photo[msg.photo.length - 1]; // highest res
    const imageBase64 = await getTelegramFileBase64(photo.file_id);
    const reply = await analyzeImage(imageBase64, caption);

    await bot.sendMessage(chatId, reply);
    addToHistory(userId, 'user', caption ? `[photo: "${caption}"]` : '[photo]');
    addToHistory(userId, 'assistant', reply);
    console.log(`👁 [${userId}] Vision done`);
  } catch (err) {
    console.error('Vision error:', err.message);
    bot.sendMessage(chatId, "Couldn't read that image 😬 try again?");
  }
});

// 🎤 Voice → STT → AI → TTS
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    await bot.sendChatAction(chatId, 'typing');

    const fileInfo = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

    const oggPath = path.join('/tmp', `voice_${userId}.ogg`);
    const mp3Path = path.join('/tmp', `voice_${userId}.mp3`);
    await downloadFile(fileUrl, oggPath);
    convertOggToMp3(oggPath, mp3Path);

    const transcribed = await transcribeVoice(mp3Path);
    console.log(`🎤 [${userId}] "${transcribed}"`);

    if (!transcribed) {
      bot.sendMessage(chatId, "Hmm couldn't hear that, try again? 🎤");
      return;
    }

    await bot.sendMessage(chatId, `_🎤 "${transcribed}"_`, { parse_mode: 'Markdown' });
    await bot.sendChatAction(chatId, 'record_voice');

    const reply = await askAI(userId, transcribed);
    const replyAudioPath = path.join('/tmp', `reply_${userId}.mp3`);
    await textToSpeech(reply, replyAudioPath);

    await bot.sendVoice(chatId, fs.createReadStream(replyAudioPath));
    await bot.sendMessage(chatId, reply);

    [oggPath, mp3Path, replyAudioPath].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    console.log(`🎤 [${userId}] voice replied`);
  } catch (err) {
    console.error('Voice error:', err.message);
    bot.sendMessage(chatId, 'Voice glitched 😬 try text instead?');
  }
});

// 💬 Text
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    await bot.sendChatAction(chatId, 'typing');
    const reply = await askAI(userId, msg.text);
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error('Text error:', err.message);
    bot.sendMessage(chatId, 'Something broke 😅 try again?');
  }
});

// ─── GLOBAL ERROR GUARDS (prevent crashes) ───────────────

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message || err);
});

// ─── BOOT ────────────────────────────────────────────────

console.log('\n🤖 Hridayai Bot is running!');
console.log(`💬 Text  → Pollinations (${Object.keys(TEXT_MODELS).join(', ')}) + Groq fallback`);
console.log(`🎨 Image → Pollinations (${Object.keys(IMAGE_MODELS).join(', ')})`);
console.log('👁 Vision → Groq Llama 4 Scout');
console.log('🎤 STT   → Groq Whisper Large v3');
console.log('🔊 TTS   → Google Translate');
console.log('📱 Open Telegram and vibe!\n');

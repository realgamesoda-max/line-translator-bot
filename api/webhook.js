const PROFILE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6시간

// Vercel warm instance 동안 유지
const profileCache =
  globalThis.__lineProfileCache ||
  (globalThis.__lineProfileCache = new Map());

const SYSTEM_PROMPT = `
You are a dedicated Korean-Japanese real-time translator.

Rules:
- Korean -> natural, polite Japanese suitable for LINE conversation.
- Japanese -> natural, polite Korean suitable for LINE conversation.
- Preserve the original meaning, nuance, tone and level of politeness.
- Never add, omit, explain, summarize, answer, or comment.
- Preserve names, numbers, dates, URLs, emojis, hashtags and line breaks.
- Preserve product names, company names and proper nouns unless there is a clearly established translation.
- Preserve code and URLs exactly.
- Output ONLY the translated text.
`.trim();

function detectDirection(text) {
  // 한글 문자 개수
  const korean =
    (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || []).length;

  // 히라가나 + 가타카나 개수
  const japanese =
    (text.match(/[\u3040-\u30ff]/g) || []).length;

  if (korean > japanese && korean > 0) {
    return 'Translate the following Korean text into natural polite Japanese.';
  }

  if (japanese > korean && japanese > 0) {
    return 'Translate the following Japanese text into natural polite Korean.';
  }

  // 한자만 있거나 애매한 문장
  return `
Detect whether the following text is primarily Korean or Japanese.
If Korean, translate it into natural polite Japanese.
If Japanese, translate it into natural polite Korean.
`.trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getProfileCacheKey(source) {
  if (!source?.userId) return null;

  if (source.type === 'group') {
    return `group:${source.groupId}:${source.userId}`;
  }

  if (source.type === 'room') {
    return `room:${source.roomId}:${source.userId}`;
  }

  return `user:${source.userId}`;
}

async function getSenderName(source) {
  if (!source?.userId) return '';

  const cacheKey = getProfileCacheKey(source);

  const cached = profileCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.timestamp < PROFILE_CACHE_TTL
  ) {
    return cached.name;
  }

  try {
    let profileUrl =
      `https://api.line.me/v2/bot/profile/${source.userId}`;

    if (source.type === 'group') {
      profileUrl =
        `https://api.line.me/v2/bot/group/${source.groupId}/member/${source.userId}`;
    } else if (source.type === 'room') {
      profileUrl =
        `https://api.line.me/v2/bot/room/${source.roomId}/member/${source.userId}`;
    }

    // 이름 때문에 번역 답장이 늦어지지 않게 제한
    const response = await fetchWithTimeout(
      profileUrl,
      {
        headers: {
          Authorization:
            `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        }
      },
      800
    );

    if (!response.ok) {
      console.error(
        'LINE profile error:',
        response.status
      );
      return '';
    }

    const data = await response.json();
    const name = data.displayName || '';

    if (name) {
      // 간단한 메모리 보호
      if (profileCache.size > 1000) {
        profileCache.clear();
      }

      profileCache.set(cacheKey, {
        name,
        timestamp: Date.now()
      });
    }

    return name;
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Profile fetch error:', error);
    }

    return '';
  }
}

async function translateText(text) {
  const direction = detectDirection(text);

  const response = await fetchWithTimeout(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',

        // API key를 URL query parameter보다 header에 넣음
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: SYSTEM_PROMPT
            }
          ]
        },

        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${direction}\n\n${text}`
              }
            ]
          }
        ],

        generationConfig: {
          // 번역에는 복잡한 reasoning이 필요 없음
          thinkingConfig: {
            thinkingLevel: 'minimal'
          }
        }
      })
    },
    8000
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini ${response.status}: ${errorText}`
    );
  }

  const data = await response.json();

  return (
    data?.candidates?.[0]?.content?.parts
      ?.filter(part => part.text && !part.thought)
      ?.map(part => part.text)
      ?.join('') || ''
  ).trim();
}

async function replyToLine(replyToken, text) {
  const response = await fetchWithTimeout(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        Authorization:
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },

      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text
          }
        ]
      })
    },
    5000
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `LINE reply ${response.status}: ${errorText}`
    );
  }
}

async function processEvent(event) {
  if (
    event.type !== 'message' ||
    event.message?.type !== 'text'
  ) {
    return;
  }

  const userMessage = event.message.text?.trim();

  if (!userMessage) return;

  const source = event.source;

  try {
    /*
     * 이름 조회 + 번역을 동시에 실행
     */
    const [senderName, translatedText] =
      await Promise.all([
        getSenderName(source),
        translateText(userMessage)
      ]);

    if (!translatedText) {
      console.error(
        'Empty Gemini translation:',
        event.webhookEventId
      );

      return;
    }

    const finalMessage = senderName
      ? `[${senderName}]\n${translatedText}`
      : translatedText;

    await replyToLine(
      event.replyToken,
      finalMessage
    );
  } catch (error) {
    console.error(
      'Event processing error:',
      event.webhookEventId,
      error
    );
  }
}

export default async function handler(req, res) {
  /*
   * LINE webhook verification 요청 등
   */
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const events = req.body?.events || [];

  /*
   * ★ 기존 코드와 가장 큰 차이
   *
   * 기존:
   * event1 완료
   * -> event2
   * -> event3
   *
   * 변경:
   * event1
   * event2  -> 동시에
   * event3
   */
  await Promise.allSettled(
    events.map(processEvent)
  );

  return res.status(200).json({
    status: 'success'
  });
}

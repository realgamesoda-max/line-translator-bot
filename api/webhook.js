const GEMINI_MODEL = 'gemini-3.6-flash';

const PROFILE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Vercel warm instance 동안 유지되는 간단한 메모리 캐시
const profileCache =
  globalThis.__lineProfileCache ||
  (globalThis.__lineProfileCache = new Map());

const SYSTEM_PROMPT = `
You are a dedicated real-time Korean-Japanese translator for a private LINE chat.

Follow these rules strictly:

1. If the input is Korean, translate it into natural and polite Japanese.
2. If the input is Japanese, translate it into natural and polite Korean.
3. Preserve the original meaning, nuance, emotion, tone, and level of politeness.
4. Prefer natural conversational language appropriate for LINE messages rather than overly literal translation.
5. Do not add information that does not exist in the original.
6. Do not omit meaningful information.
7. Preserve names, numbers, dates, URLs, emojis, emoticons, hashtags, and line breaks whenever appropriate.
8. Preserve proper nouns and product/company names unless there is a clearly established translation.
9. Do not answer the message. Only translate it.
10. Do not explain the translation.
11. Do not say things like "Translation:".
12. Output ONLY the translated text.
`.trim();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 5000
) {
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

function detectTranslationDirection(text) {
  const koreanCount =
    (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || []).length;

  const japaneseKanaCount =
    (text.match(/[ぁ-んァ-ヶー]/g) || []).length;

  if (koreanCount > 0 && koreanCount >= japaneseKanaCount) {
    return `
The source language is Korean.
Translate the message into natural, polite Japanese.
`.trim();
  }

  if (japaneseKanaCount > 0) {
    return `
The source language is Japanese.
Translate the message into natural, polite Korean.
`.trim();
  }

  // 한자만 있거나 언어 판별이 애매한 경우 Gemini에게 맡김
  return `
Determine whether the following message is primarily Korean or Japanese.

If it is Korean, translate it into natural, polite Japanese.
If it is Japanese, translate it into natural, polite Korean.

Output only the translated message.
`.trim();
}

function getProfileCacheKey(source) {
  if (!source?.userId) {
    return null;
  }

  if (source.type === 'group') {
    return `group:${source.groupId}:${source.userId}`;
  }

  if (source.type === 'room') {
    return `room:${source.roomId}:${source.userId}`;
  }

  return `user:${source.userId}`;
}

async function getSenderName(source) {
  if (!source?.userId) {
    return '';
  }

  const cacheKey = getProfileCacheKey(source);

  if (!cacheKey) {
    return '';
  }

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

    /*
     * 이름 조회 때문에 번역이 오래 지연되지 않도록
     * 900ms 안에 못 받아오면 이름 없이 번역
     */
    const response = await fetchWithTimeout(
      profileUrl,
      {
        headers: {
          Authorization:
            `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        }
      },
      900
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        '[LINE PROFILE ERROR]',
        response.status,
        errorText
      );

      return '';
    }

    const data = await response.json();

    const name = data?.displayName || '';

    if (name) {
      /*
       * 메모리 무한 증가 방지
       */
      if (profileCache.size >= 1000) {
        profileCache.clear();
      }

      profileCache.set(cacheKey, {
        name,
        timestamp: Date.now()
      });
    }

    return name;
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.warn(
        '[LINE PROFILE TIMEOUT]',
        source?.userId
      );
    } else {
      console.error(
        '[LINE PROFILE FETCH ERROR]',
        error
      );
    }

    return '';
  }
}

function extractGeminiText(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts || [];

  return parts
    .filter(part => {
      return part?.text && !part?.thought;
    })
    .map(part => part.text)
    .join('')
    .trim();
}

async function translateWithGemini(userMessage) {
  /*
   * 첫 요청 + 최대 2회 retry
   */
  const maxRetries = 2;

  const direction =
    detectTranslationDirection(userMessage);

  for (
    let attempt = 0;
    attempt <= maxRetries;
    attempt++
  ) {
    try {
      const response = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',

            /*
             * API key를 URL에 넣는 대신 header 사용
             */
            'x-goog-api-key':
              process.env.GEMINI_API_KEY
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
                    text:
                      `${direction}\n\n` +
                      `MESSAGE:\n${userMessage}`
                  }
                ]
              }
            ],

            generationConfig: {
              /*
               * 번역은 복잡한 reasoning이 필요 없으므로
               * Gemini 3 thinking을 최소화
               */
              thinkingConfig: {
                thinkingLevel: 'minimal'
              },

              /*
               * LINE 한 메시지 번역에는 충분
               * 비정상적으로 긴 출력 방지
               */
              maxOutputTokens: 2048
            }
          })
        },

        /*
         * Gemini 최대 7초 대기
         */
        7000
      );

      if (!response.ok) {
        const errorText =
          await response.text();

        console.error(
          `[GEMINI ERROR] attempt=${attempt + 1}`,
          `status=${response.status}`,
          errorText
        );

        /*
         * 일시적인 서버/쿼터 오류만 retry
         */
        const retryable =
          response.status === 429 ||
          response.status === 500 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;

        if (
          retryable &&
          attempt < maxRetries
        ) {
          /*
           * 실시간 번역이라 짧은 backoff 사용
           *
           * 250ms
           * 500ms
           */
          await sleep(
            250 * Math.pow(2, attempt)
          );

          continue;
        }

        return '';
      }

      const data = await response.json();

      const translatedText =
        extractGeminiText(data);

      if (translatedText) {
        return translatedText;
      }

      console.error(
        `[GEMINI EMPTY OUTPUT] attempt=${attempt + 1}`,
        JSON.stringify(data)
      );

      if (attempt < maxRetries) {
        await sleep(
          250 * Math.pow(2, attempt)
        );

        continue;
      }

      return '';
    } catch (error) {
      if (error?.name === 'AbortError') {
        console.error(
          `[GEMINI TIMEOUT] attempt=${attempt + 1}`
        );
      } else {
        console.error(
          `[GEMINI FETCH ERROR] attempt=${attempt + 1}`,
          error
        );
      }

      if (attempt < maxRetries) {
        await sleep(
          250 * Math.pow(2, attempt)
        );

        continue;
      }

      return '';
    }
  }

  return '';
}

async function replyToLine(
  replyToken,
  text
) {
  try {
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
      const errorText =
        await response.text();

      console.error(
        '[LINE REPLY ERROR]',
        response.status,
        errorText
      );

      return false;
    }

    return true;
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.error(
        '[LINE REPLY TIMEOUT]'
      );
    } else {
      console.error(
        '[LINE REPLY FETCH ERROR]',
        error
      );
    }

    return false;
  }
}

async function processEvent(event) {
  /*
   * 텍스트 메시지만 번역
   *
   * 스티커 / 사진 / 영상 등은 무시
   */
  if (
    event?.type !== 'message' ||
    event?.message?.type !== 'text'
  ) {
    return;
  }

  const userMessage =
    event.message.text?.trim();

  if (!userMessage) {
    return;
  }

  const eventId =
    event.webhookEventId || 'unknown';

  console.log(
    `[EVENT RECEIVED] id=${eventId}`,
    `source=${event?.source?.type}`,
    `text=${JSON.stringify(userMessage)}`
  );

  try {
    /*
     * ★ 프로필 + Gemini 번역 동시 실행
     */
    const [
      senderName,
      translatedText
    ] = await Promise.all([
      getSenderName(event.source),
      translateWithGemini(userMessage)
    ]);

    if (!translatedText) {
      console.error(
        `[TRANSLATION FAILED] id=${eventId}`
      );

      return;
    }

    const finalMessage =
      senderName
        ? `[${senderName}]\n${translatedText}`
        : translatedText;

    console.log(
      `[TRANSLATION SUCCESS] id=${eventId}`,
      JSON.stringify(translatedText)
    );

    const sent = await replyToLine(
      event.replyToken,
      finalMessage
    );

    if (sent) {
      console.log(
        `[LINE REPLY SUCCESS] id=${eventId}`
      );
    } else {
      console.error(
        `[LINE REPLY FAILED] id=${eventId}`
      );
    }
  } catch (error) {
    console.error(
      `[EVENT PROCESSING ERROR] id=${eventId}`,
      error
    );
  }
}

export default async function handler(
  req,
  res
) {
  /*
   * LINE webhook verification 등
   */
  if (req.method !== 'POST') {
    return res
      .status(200)
      .send('OK');
  }

  try {
    const events =
      Array.isArray(req.body?.events)
        ? req.body.events
        : [];

    if (events.length === 0) {
      return res
        .status(200)
        .json({
          status: 'ok',
          events: 0
        });
    }

    /*
     * ★ 여러 이벤트가 동시에 들어오면 병렬 처리
     *
     * 하나 실패해도 다른 이벤트는 계속 처리
     */
    await Promise.allSettled(
      events.map(processEvent)
    );

    return res
      .status(200)
      .json({
        status: 'success'
      });
  } catch (error) {
    console.error(
      '[WEBHOOK ERROR]',
      error
    );

    /*
     * LINE이 같은 webhook을 계속 실패로 판단하지 않도록
     * 서버 내부 처리 오류도 일단 응답
     */
    return res
      .status(200)
      .json({
        status: 'handled_with_error'
      });
  }
}

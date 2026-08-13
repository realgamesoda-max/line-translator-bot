export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;
        const source = event.source;

        // 1. 메시지 보낸 사람 이름(프로필) 가져오기
        let senderName = '';
        try {
          let profileUrl = `https://api.line.me/v2/bot/profile/${source.userId}`;
          if (source.type === 'group') {
            profileUrl = `https://api.line.me/v2/bot/group/${source.groupId}/member/${source.userId}`;
          } else if (source.type === 'room') {
            profileUrl = `https://api.line.me/v2/bot/room/${source.roomId}/member/${source.userId}`;
          }

          const profileRes = await fetch(profileUrl, {
            headers: {
              'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
            }
          });
          const profileData = await profileRes.json();
          if (profileData.displayName) {
            senderName = profileData.displayName;
          }
        } catch (e) {
          console.error('Failed to fetch profile:', e);
        }

        // 2. Gemini 3.6 Flash 번역 호출
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: userMessage }] }],
              systemInstruction: {
                parts: [{
                  text: `너는 한국어와 일본어 전담 실시간 번역기야.
                  1. 입력이 한국어면 -> 정중한 일본어 존댓말(丁寧語/敬語)로 번역해.
                  2. 입력이 일본어면 -> 정중한 한국어 존댓말(~해요/하십시오체)로 번역해.
                  3. 인사, 설명 등 번역문 외의 어떤 텍스트도 절대 출력하지 말고 오직 번역 결과만 출력해.`
                }]
              }
            })
          }
        );

        const geminiData = await geminiRes.json();
        const translatedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // 3. [보낸사람 이름] + 번역문 조합하여 라인 전송
        if (translatedText.trim()) {
          const finalMessage = senderName 
            ? `[${senderName}]\n${translatedText.trim()}`
            : translatedText.trim();

          await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
              replyToken: replyToken,
              messages: [{ type: 'text', text: finalMessage }]
            })
          });
        }
      }
    }
    return res.status(200).json({ status: 'success' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

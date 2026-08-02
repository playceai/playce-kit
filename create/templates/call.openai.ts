    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: model(),
        // Newer OpenAI models reject `max_tokens`; this is its replacement.
        max_completion_tokens: maxTokens(),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`openai HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return (data.choices?.[0]?.message?.content ?? "").trim();

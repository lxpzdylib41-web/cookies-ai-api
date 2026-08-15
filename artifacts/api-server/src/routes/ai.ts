import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type SolveRequest = {
  message?: unknown;
  history?: unknown;
  model?: unknown;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

type GeminiRequest = {
  contents: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }>;
  generationConfig: {
    maxOutputTokens: number;
    responseMimeType: "application/json";
  };
};

type GeminiErrorResponse = {
  error?: {
    message?: string;
  };
};

function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string" &&
    item.content.length <= 2_000
  );
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cleanAnswer(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/[\r\n]+/g, " ").slice(0, 200)
    : "";
}

router.post("/ai/solve", async (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    res.status(503).json({
      error: "AI service is not configured on the server",
    });
    return;
  }

  const body = (req.body ?? {}) as SolveRequest;
  const message =
    typeof body.message === "string" ? body.message.trim() : "";

  if (!message || message.length > 4_000) {
    res.status(400).json({
      error: "message must be a non-empty string of 4,000 characters or fewer",
    });
    return;
  }

  const history = Array.isArray(body.history)
    ? body.history.filter(isHistoryMessage).slice(-10)
    : [];

  // Keep model selection server-controlled by default. A caller may only
  // request a known model, never an arbitrary model name.
  const model =
    body.model === "gemini-3-flash-preview"
      ? body.model
      : "gemini-3-flash-preview";

  const systemInstruction =
    "You are a concise riddle and puzzle assistant. Return valid JSON only, with this exact shape: " +
    '{"riddle":true,"answers":["one likely answer"],"explanation":"brief explanation"}. ' +
    "If the input is not a riddle or there is not enough information, return " +
    '{"riddle":false,"answers":[],"explanation":"not enough information"}. ' +
    "Answers must be short, plain text strings. Never include markdown.";

  const contents: GeminiRequest["contents"] = [
    {
      role: "user",
      parts: [{ text: systemInstruction }],
    },
    ...history.map((item) => ({
      role: item.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: item.content }],
    })),
    {
      role: "user",
      parts: [{ text: message }],
    },
  ];

  try {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            maxOutputTokens: 8_192,
            responseMimeType: "application/json",
          },
        } satisfies GeminiRequest),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!geminiResponse.ok) {
      const providerBody = (await geminiResponse.json().catch(() => null)) as
        | GeminiErrorResponse
        | null;
      req.log?.error(
        { statusCode: geminiResponse.status },
        "Gemini request failed",
      );
      res.status(502).json({
        error: "AI provider request failed",
        status: geminiResponse.status,
        details:
          process.env.NODE_ENV === "production"
            ? undefined
            : providerBody?.error?.message?.slice(0, 500),
      });
      return;
    }

    const data = (await geminiResponse.json()) as GeminiResponse;
    const content =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";
    const parsed = parseJsonObject(content);
    const answer = cleanAnswer(
      Array.isArray(parsed?.answers) ? parsed.answers[0] : undefined,
    );
    const riddle = parsed?.riddle === true && answer.length > 0;

    res.json({
      riddle,
      answers: riddle ? [answer] : [],
      explanation: cleanAnswer(parsed?.explanation),
    });
  } catch (error) {
    req.log?.error({ err: error }, "AI request error");
    res.status(502).json({
      error: "Unable to reach AI provider",
    });
  }
});

export default router;
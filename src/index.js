// Recipe Box API — Cloudflare Worker
// Handles recipe CRUD (via D1) and photo storage (via R2). Open access — no passcode.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your Pages domain once deployed, e.g. "https://recipe-box.pages.dev"
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- AI recipe parsing ---

    if (path === "/api/parse-recipe" && method === "POST") {
      const { rawText } = await request.json();
      if (!rawText || !rawText.trim()) {
        return json({ error: "No text provided" }, 400);
      }

      const prompt = `You will be given raw, informally-written recipe notes copied from someone's notes app. They may have no headers, inconsistent formatting, and trailing asides that aren't real steps.

Extract structured recipe data. Respond with ONLY a raw JSON object, no markdown fences, no preamble, matching exactly this shape:
{"title": string, "ingredients": string[], "steps": string[], "notes": string}

Rules:
- "ingredients" are lines with quantities or food items, even without a header.
- "steps" are cooking instructions in order, each a short standalone sentence.
- "notes" is a single string for asides, questions, or variations that aren't ingredients or steps (e.g. "Add vanilla and cinnamon?"). Use an empty string if there are none.
- If no clear title exists, infer a short, plain one from the content.
- Do not invent ingredients or steps that aren't implied by the text.

Raw notes:
"""
${rawText}
"""`;

      try {
        const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: 1000,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!anthropicRes.ok) {
          const errText = await anthropicRes.text();
          return json({ error: "Anthropic API error", detail: errText }, 502);
        }

        const data = await anthropicRes.json();
        const textBlock = (data.content || []).find((b) => b.type === "text");
        if (!textBlock) return json({ error: "No text in AI response" }, 502);

        const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        return json(parsed);
      } catch (e) {
        return json({ error: "Parsing failed", detail: String(e) }, 500);
      }
    }

    // --- Recipes ---

    if (path === "/api/recipes" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM recipes ORDER BY created_at DESC"
      ).all();
      const recipes = results.map(rowToRecipe);
      return json({ recipes });
    }

    if (path === "/api/recipes" && method === "POST") {
      const body = await request.json();
      const recipe = normalizeIncoming(body);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO recipes (id, title, ingredients, steps, notes, tags, photo_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          recipe.id,
          recipe.title,
          JSON.stringify(recipe.ingredients),
          JSON.stringify(recipe.steps),
          recipe.notes,
          JSON.stringify(recipe.tags),
          recipe.photoKey || null,
          recipe.createdAt
        )
        .run();
      return json({ recipe });
    }

    const recipeIdMatch = path.match(/^\/api\/recipes\/([a-zA-Z0-9_-]+)$/);
    if (recipeIdMatch && method === "PUT") {
      const id = recipeIdMatch[1];
      const body = await request.json();
      const recipe = normalizeIncoming({ ...body, id });
      await env.DB.prepare(
        `UPDATE recipes SET title=?, ingredients=?, steps=?, notes=?, tags=?, photo_key=? WHERE id=?`
      )
        .bind(
          recipe.title,
          JSON.stringify(recipe.ingredients),
          JSON.stringify(recipe.steps),
          recipe.notes,
          JSON.stringify(recipe.tags),
          recipe.photoKey || null,
          id
        )
        .run();
      return json({ recipe });
    }

    if (recipeIdMatch && method === "DELETE") {
      const id = recipeIdMatch[1];
      await env.DB.prepare("DELETE FROM recipes WHERE id=?").bind(id).run();
      return json({ deleted: id });
    }

    // --- Photos ---

    if (path === "/api/photos" && method === "POST") {
      const formData = await request.formData();
      const file = formData.get("photo");
      if (!file) return json({ error: "No photo provided" }, 400);
      const key = `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      await env.PHOTOS.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "image/jpeg" },
      });
      return json({ key });
    }

    const photoKeyMatch = path.match(/^\/api\/photos\/(.+)$/);
    if (photoKeyMatch && method === "GET") {
      const key = photoKeyMatch[1];
      const object = await env.PHOTOS.get(key);
      if (!object) return json({ error: "Photo not found" }, 404);
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "public, max-age=31536000",
          ...CORS_HEADERS,
        },
      });
    }

    if (photoKeyMatch && method === "DELETE") {
      const key = photoKeyMatch[1];
      await env.PHOTOS.delete(key);
      return json({ deleted: key });
    }

    return json({ error: "Not found" }, 404);
  },
};

function rowToRecipe(row) {
  return {
    id: row.id,
    title: row.title,
    ingredients: JSON.parse(row.ingredients),
    steps: JSON.parse(row.steps),
    notes: row.notes || "",
    tags: JSON.parse(row.tags),
    photoKey: row.photo_key || null,
    createdAt: row.created_at,
  };
}

function normalizeIncoming(body) {
  return {
    id: body.id || crypto.randomUUID(),
    title: (body.title || "").trim(),
    ingredients: Array.isArray(body.ingredients) ? body.ingredients : [],
    steps: Array.isArray(body.steps) ? body.steps : [],
    notes: body.notes || "",
    tags: Array.isArray(body.tags) ? body.tags : [],
    photoKey: body.photoKey || null,
    createdAt: body.createdAt || Date.now(),
  };
}

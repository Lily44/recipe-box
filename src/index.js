// Recipe Box API — Cloudflare Worker
// Handles recipe CRUD (via D1) and photo storage (via R2), gated by a single passcode.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your Pages domain once deployed, e.g. "https://recipe-box.pages.dev"
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Passcode",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function checkPasscode(request, env) {
  const provided = request.headers.get("X-Passcode");
  return provided && provided === env.APP_PASSCODE;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (!checkPasscode(request, env)) {
      return json({ error: "Invalid or missing passcode" }, 401);
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
        `INSERT INTO recipes (id, title, ingredients, steps, notes, tags, photo_key, created_at)
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

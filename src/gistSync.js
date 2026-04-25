const GIST_DESCRIPTION = "Taxi Sales Management Auto Backup";
const GIST_FILENAME = "taxi-sales.json";

export const PAT_KEY = "taxi_sales_pat";
export const GIST_ID_KEY = "taxi_sales_gist_id";

export const getPat = () => localStorage.getItem(PAT_KEY) || "";
export const setPat = (v) => v ? localStorage.setItem(PAT_KEY, v) : localStorage.removeItem(PAT_KEY);
export const getGistId = () => localStorage.getItem(GIST_ID_KEY) || "";
export const setGistId = (v) => v ? localStorage.setItem(GIST_ID_KEY, v) : localStorage.removeItem(GIST_ID_KEY);

const headers = (pat) => ({
  Authorization: `Bearer ${pat}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

async function ghFetch(url, pat, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...headers(pat), ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 120)}`);
  }
  return res.json();
}

export async function validatePat(pat) {
  return ghFetch("https://api.github.com/user", pat);
}

export async function findExistingGist(pat) {
  const list = await ghFetch("https://api.github.com/gists?per_page=100", pat);
  return list.find((g) => g.description === GIST_DESCRIPTION) || null;
}

export async function createGist(pat, data) {
  return ghFetch("https://api.github.com/gists", pat, {
    method: "POST",
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) } },
    }),
  });
}

export async function pushToGist(pat, gistId, data) {
  return ghFetch(`https://api.github.com/gists/${gistId}`, pat, {
    method: "PATCH",
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: JSON.stringify(data, null, 2) } },
    }),
  });
}

export async function pullFromGist(pat, gistId) {
  const g = await ghFetch(`https://api.github.com/gists/${gistId}`, pat);
  const file = g.files?.[GIST_FILENAME];
  if (!file) throw new Error("バックアップファイルが見つかりません");
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const r = await fetch(file.raw_url);
    content = await r.text();
  }
  return { data: JSON.parse(content), updatedAt: g.updated_at };
}

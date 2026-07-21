// Small helper wrapper around fetch + localStorage auth state
const Auth = {
  getToken() { return localStorage.getItem("hp_token"); },
  getUser() {
    const raw = localStorage.getItem("hp_user");
    return raw ? JSON.parse(raw) : null;
  },
  setSession(token, user) {
    localStorage.setItem("hp_token", token);
    localStorage.setItem("hp_user", JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem("hp_token");
    localStorage.removeItem("hp_user");
  },
  requireAuth() {
    if (!this.getToken()) window.location.href = "/index.html";
  },
};

async function api(path, options = {}) {
  const token = Auth.getToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

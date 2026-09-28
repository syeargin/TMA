// Calls the Team Hub API with the signed-in user's access token.
import { fetchAuthSession } from "aws-amplify/auth";

let base = "";
export const configureApi = (cfg) => { base = String(cfg.apiUrl || "").replace(/\/$/, ""); return !!base; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status}).`);
    this.status = status;
    this.code = body?.error;
  }
}

/** The signed-in user's access token (refreshed by Amplify when needed; force to refresh now). */
export async function accessToken(forceRefresh = false) {
  const { tokens } = await fetchAuthSession({ forceRefresh });
  return tokens?.accessToken?.toString();
}

export async function api(method, path, body) {
  if (!base) throw new ApiError(0, { message: "The API isn't set up for this environment." });
  const token = await accessToken();
  if (!token) throw new ApiError(401, { message: "Sign in to continue." });
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, { message: "Couldn't reach the server. Check your connection and try again." });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

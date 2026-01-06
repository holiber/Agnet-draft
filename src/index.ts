export function helloWorld(name?: string): string {
  const who = name?.trim() ? name.trim() : "world";
  return `Hello, ${who}!`;
}

export { Api } from "./api/api.js";
export * from "./api/registry.js";
export * from "./api/snapshot.js";
export * from "./api/api-host.js";
export * from "./api/doc-renderer.js";

export * from "./agnet.js";
export * from "./agent-mdx.js";
export * from "./local-runtime.js";
export * from "./protocol.js";
export * from "./framing.js";
export * from "./stdio-transport.js";


import base from "../../eslint.config.mjs";

export default base.map((config) => config.files ? { ...config, files: ["tools/mcp-bridge/**/*.ts"] } : config);

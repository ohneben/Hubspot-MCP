import { defineConfig } from "vitest/config";

/**
 * The source uses NodeNext-style import specifiers (`./openapi.js`) that point at
 * TypeScript files. This tiny resolver rewrites a relative `*.js` import to `*.ts`
 * when a matching TS file exists, so Vitest can load the source directly.
 */
export default defineConfig({
  plugins: [
    {
      name: "resolve-ts-from-js-specifier",
      enforce: "pre",
      async resolveId(source, importer) {
        if (importer && source.startsWith(".") && source.endsWith(".js")) {
          const resolved = await this.resolve(source.slice(0, -3) + ".ts", importer, { skipSelf: true });
          if (resolved) return resolved.id;
        }
        return null;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vite";

const entryId = "virtual:neon-lane-entry";
const resolvedEntryId = `\0${entryId}`;
const entryPath = "/src/main.js";
const projectEntryPath = resolve("src/main.js");
const hasProjectEntry = existsSync(projectEntryPath);
const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Neon Lane TV</title>
  </head>
  <body>
    <script type="module" src="${entryPath}"></script>
  </body>
</html>
`;

function projectFoundation() {
  return {
    name: "project-foundation",
    resolveId(id) {
      if (id === entryId || (!hasProjectEntry && id === entryPath)) {
        return resolvedEntryId;
      }
    },
    load(id) {
      if (id === resolvedEntryId) {
        return [
          'import { REVISION } from "three";',
          'console.info(`Three.js r${REVISION}`);',
        ].join("\n");
      }
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split("?")[0];
        if (pathname !== "/" && pathname !== "/index.html") {
          next();
          return;
        }

        try {
          const html = await server.transformIndexHtml(request.url, page);
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (item) => item.type === "chunk" && item.isEntry,
      );

      this.emitFile({
        type: "asset",
        fileName: "index.html",
        source: page.replace(entryPath, `/${entry.fileName}`),
      });
    },
  };
}

export default defineConfig({
  plugins: [projectFoundation()],
  build: {
    rollupOptions: {
      input: hasProjectEntry ? projectEntryPath : entryId,
    },
  },
});

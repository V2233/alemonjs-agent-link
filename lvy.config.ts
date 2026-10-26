import { defineConfig } from 'lvyjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const __dirname = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  // watch: [],
  alias: {
    entries: [{ find: '@src', replacement: join(__dirname, 'src') }]
  }
})

import { copyFile, mkdir } from 'node:fs/promises'

await mkdir('dist/src', { recursive: true })
await Promise.all([
  copyFile('index.html', 'dist/index.html'),
  copyFile('src/main.js', 'dist/src/main.js'),
  copyFile('src/pcm.js', 'dist/src/pcm.js'),
  copyFile('src/style.css', 'dist/src/style.css'),
  copyFile('public/favicon.png', 'dist/favicon.png'),
])

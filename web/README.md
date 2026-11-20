# MIMO-TTS

小米 MiMo 语音合成网页。可在本机用 Python 3 标准库运行，也可部署到 Vercel。

## 启动

```bash
cd web
python3 server.py
```

打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)，在「模型配置」填写小米 `MIMO_API_KEY`、选择模型。点「测试连接」会用当前填写的 Key 和所选模型合成一句短音频，点「保存并生效」才会应用配置。

- `mimo-v2.5-tts` 使用预置发音人，也是默认模型。
- `mimo-v2.5-tts-voicedesign` 使用「朗读风格」里的音色描述。
- `mimo-v2.5-tts-voiceclone` 使用 MP3 或 WAV 参考音频。本地最大 7.5 MB，Vercel 最大 3.3 MB。音频文件仅在当前页面保留，刷新后需重新选择。

输入文本后，点「播放」或「下载」即可合成 WAV。在「朗读风格」里可以选预设或手写朗读指令。

API Key 保存在当前站点的浏览器 localStorage，可以在「模型配置」清除。服务端在合成时把 Key 转发给小米官方接口。

使用 ClashX 代理时，可以这样启动。

```bash
HTTPS_PROXY=http://127.0.0.1:7890 python3 server.py
```

## Vercel

在 Vercel 导入仓库，将 Root Directory 设为 `web`。构建脚本将网页文件复制到 `dist/`，`api/` 下的函数保留语音合成和连接测试接口。访问者在网页内填写自己的 MiMo API Key。

[小米 MiMo 语音合成文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)

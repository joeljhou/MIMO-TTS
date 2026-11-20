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

默认模型点击「播放」后会先缓冲 PCM 音频。接收速度足够时会边生成边播放，接收较慢时会等剩余音频到齐再播放。合成结束后，同一份音频可以重播或下载为 WAV。直接点击「下载」以及使用音色设计、音色复刻时，走完整 WAV 合成。「朗读风格」支持预设和自定义指令。

API Key 保存在当前站点的浏览器 localStorage，可以在「模型配置」清除。服务端在合成时把 Key 转发给小米官方接口。

给 Bob 准备复刻样本时，点击文本框左上角的「复刻样本」，选择不超过 7.5 MB 的 MP3 或 WAV，点「复制 Base64」，再粘贴到 Bob 的「高级：音色复刻样本」。转换在浏览器中完成，无需 API Key。

使用 ClashX 代理时，可以这样启动。

```bash
HTTPS_PROXY=http://127.0.0.1:7890 python3 server.py
```

默认只监听本机（127.0.0.1）。要让手机等同局域网设备访问，用 `TTS_HOST` 监听全部网卡，启动日志会列出所有可访问地址，其他设备用其中任意一个打开即可（端口可用 `TTS_PORT` 修改）。

```bash
TTS_HOST=0.0.0.0 python3 server.py
```

首次以这种方式启动时，macOS 可能弹窗询问是否允许 Python 接收传入网络连接，选择「允许」即可。接口仍会校验 Host 与 Origin，只接受指向本机地址、来自本服务页面的请求；同一网络下的其他人也能打开页面并使用自己的 API Key，请仅在可信网络中开放。

## Vercel

在 Vercel 导入仓库，将 Root Directory 设为 `web`。构建脚本将网页文件复制到 `dist/`，`api/` 下的 Node.js 函数提供流式播放、完整 WAV 合成和连接测试。本地预览使用 `server.py` 提供同样的接口。访问者在网页内填写自己的 MiMo API Key。

[小米 MiMo 语音合成文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)

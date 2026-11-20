# MIMO-TTS

用小米 MiMo 把文字转成语音。可以在浏览器里试听和下载 WAV，也可以把 MiMo 接入 macOS 上的 Bob。

**[打开网页版](https://mimo-tts.geekyspace.cn/)** · **[下载 Bob 插件](https://raw.githubusercontent.com/joeljhou/MIMO-TTS/main/bob-plugin/MIMO-TTS.bobplugin)**

## 快速上手

1. 在小米 MiMo 控制台创建自己的 API Key。[获取 `MIMO_API_KEY`](https://platform.xiaomimimo.com/console/api-keys)
2. **网页版**打开「模型配置」，填入 Key 并保存，然后输入文字、选择音色，点击「播放」或「下载」。默认模型支持边生成边播放。
3. **Bob 插件**下载后双击安装。在 Bob 1.8.0 或更新版本中，打开「偏好设置 → 服务 → 语音合成」，添加 MIMO-TTS，填入 Key 后点击「验证」。[Bob 安装与配置说明](bob-plugin/README.md)

## 音色与模型

| 模型 | 用途 |
| --- | --- |
| `mimo-v2.5-tts` | 使用冰糖、茉莉、Mia 等预置音色，也可以交给 MiMo 按部署集群选择默认音色。 |
| `mimo-v2.5-tts-voicedesign` | 用文字描述年龄、声线或语气，生成定制音色。 |
| `mimo-v2.5-tts-voiceclone` | 用 MP3 或 WAV 作为参考音频，复刻音色。 |

网页版和 Bob 都支持朗读风格预设和自定义指令。给 Bob 准备复刻样本时，可以用网页顶部的「复刻样本」把音频转成 Base64，在当前浏览器内完成转换。[小米 MiMo 语音合成文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)

## 本地运行与部署

- `web/` 包含网页版、Vercel API 函数和本地 Python 服务。Vercel 的根目录设为 `web`。[启动与部署说明](web/README.md)
- `bob-plugin/` 包含 Bob 插件源码和 `.bobplugin` 安装包。[插件说明](bob-plugin/README.md)

在仓库根目录运行以下命令，然后打开 [本地网页](http://127.0.0.1:8765/)。

```bash
cd web
python3 server.py
```

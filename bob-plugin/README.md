# MIMO-TTS Bob 插件

Bob 语音合成插件，直接调用小米 MiMo，无需启动网页或本地服务。当前版本 0.2.3，需要 Bob 1.8.0 或以上版本。[插件主页](https://github.com/joeljhou/MIMO-TTS)

## 安装与试听

1. 双击同目录里的 MIMO-TTS.bobplugin 安装。
2. 打开 Bob 的「偏好设置 → 服务 → 语音合成」，点左下角的「+」，添加 MIMO-TTS。
3. 填入 [小米 MiMo 控制台的 API Key](https://platform.xiaomimimo.com/console/api-keys)，保留默认模型和冰糖音色，点「验证」。
4. 打开 MIMO-TTS 服务的开关并保存，然后在 Bob 中用一段中文短句试听。如果扬声器仍使用离线语音，可先关掉离线服务进行单独测试。

## 配置顺序

先选择「模型」，再按该模型填写下面的配置。Bob 的插件配置页是静态的，未使用的字段会保留显示，但请求时会自动忽略。

- **预置音色模型**。使用「预置音色」和「朗读风格预设」。
- **音色设计模型**。使用「音色描述」和「朗读风格预设」，预置音色会被忽略。
- **音色复刻模型**。使用「高级：音色复刻样本」和「朗读风格预设」，预置音色会被忽略。样本需要是完整的 WAV 或 MP3 Base64 Data URL，内容上限为 10 MB。

自定义朗读风格填了内容后会覆盖预设。「验证」会用所选模型合成一句短语音。使用复刻模型验证时需要先填样本。

在网页文本框左上角点「复刻样本」，选择 MP3 或 WAV，点「复制 Base64」，再粘贴到 Bob 的「高级：音色复刻样本」。[转换工具](https://mimo-tts.geekyspace.cn/)

也可以用终端复制自己的 WAV 样本 Data URL 到剪贴板（MP3 请将前缀换为 audio/mpeg）：

    { printf 'data:audio/wav;base64,'; base64 -i "/你的音频路径/sample.wav" | tr -d '\n'; } | pbcopy

## 重复播放

相同文本和合成配置会复用内存中的音频。缓存从生成成功起保留 10 分钟，最多 10 条、8 MiB Base64，单条上限 2 MiB。容量不足时优先清理最久未使用的音频。相同请求正在生成时会合并为一次，点击「验证」时仍会检查实际连接。

## 重新打包

在此目录执行：

    zip -j MIMO-TTS.bobplugin info.json main.js icon.png

[Bob 插件安装说明](https://bobtranslate.com/guide/advance/plugin.html) · [小米 MiMo TTS 文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)

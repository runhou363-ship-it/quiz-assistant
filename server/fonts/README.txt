NotoSansSC-VF.ttf — 字体解码用的参考字体
==========================================

用途
----
雨课堂 / 学堂在线的加密字体内部名称是 "Source Han Sans SC VF"
（思源黑体简体中文 · 可变字体，ExtraLight 字重）。本工具把页面字体里的
混淆字形渲染成位图，与这份参考字体的字形逐个比对，才能把假字还原成真字。
用微软雅黑等其它字体比对时拟合只有 ~1.0，形近字（学→字、统→绞、机→村）
会反复认错；用同源字体后拟合约 1.97，错字消失。

来源与许可
----------
这是 Windows 系统自带字体 C:\Windows\Fonts\NotoSansSC-VF.ttf 的副本，
对应 Google Noto Sans SC / Adobe Source Han Sans SC，采用
SIL Open Font License 1.1（允许随软件再分发、可用于商业与非商业用途）。
许可全文： https://openfontlicense.org/  /  https://scripts.sil.org/OFL
本项目仅把它作为字形比对参考，未修改字体本身。

说明
----
程序会优先查找本目录下的副本，其次查找系统字体目录：
  C:\Windows\Fonts\NotoSansSC-VF.ttf
  C:\Windows\Fonts\SourceHanSansSC-VF.ttf
  Linux: /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
如果都找不到，会回退到微软雅黑等字体，仍能解码但准确率明显下降。
后端 /status 的 font_refs 列表里有 "sourcehan" 即表示已启用。

字体文件约 17 MB，运行时会在 server/cache/ 生成对应的位图缓存（.npz），
首次构建需要几秒，之后秒级加载。

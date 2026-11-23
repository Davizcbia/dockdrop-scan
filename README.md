# DockDrop 配对扫描页

DockOver 的 DockDrop 手机端扫描页。在电脑上打开 DockOver 的"添加设备"后，会出现一团蓝色光点；用手机浏览器打开本页、对准光点，就能把手机和电脑配对，之后可以互传文件、同步剪贴板。

- 识别在手机本地完成，画面不会上传。
- 配对通过 WebRTC 在手机和电脑之间直接连接，并用光点里的一次性密钥互相验证。
- iPhone（Safari）和安卓（Chrome）都可以用，也可以"添加到主屏幕"。

源代码在 DockOver 仓库的 `dockui/web/dockdrop-scan/` 中维护，这里是发布用的副本。

---

Phone scanner page for DockOver's DockDrop pairing. It decodes the particle orb shown by DockOver on the phone itself, then pairs over a direct WebRTC connection authenticated by the orb's one-time secret.

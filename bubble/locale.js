export function selectLocale(languages) {
  for (const tag of languages) {
    const language = tag.toLowerCase();
    if (language === 'en' || language.startsWith('en-')) return 'en';
    if (language === 'zh' || language.startsWith('zh-')) {
      return /^zh-(?:hant(?:-|$)|tw$|hk$|mo$)/.test(language) ? 'zh-Hant' : 'zh-Hans';
    }
  }
  return 'en';
}

export const locale = selectLocale(navigator.languages?.length ? navigator.languages : [navigator.language || 'en']);

// Simplified Chinese is the source text. The two columns are English and Traditional Chinese.
const messages = {
  'DockDrop 配对 · 光泡扫描': ['DockDrop · Scan to pair', 'DockDrop 配對 · 光泡掃描'],
  '收发方向': ['Transfer direction', '收發方向'],
  '发送到电脑': ['Send to PC', '傳送到電腦'],
  '从电脑接收': ['Receive from PC', '從電腦接收'],
  '文件': ['Files', '檔案'],
  '文字': ['Text', '文字'],
  '输入或粘贴文字': ['Type or paste text', '輸入或貼上文字'],
  '打开相机': ['Open camera', '開啟相機'],
  '关闭相机': ['Close camera', '關閉相機'],
  '继续配对': ['Continue pairing', '繼續配對'],
  '返回收发': ['Back to transfer', '返回收發'],
  '取消': ['Cancel', '取消'],
  '找到光泡，保持不动': ['Bubble found. Hold still.', '找到光泡，請保持不動'],
  '测试模式 · {hint}': ['Test mode · {hint}', '測試模式 · {hint}'],
  '只读码': ['Scan only', '只讀碼'],
  '相机需要 HTTPS 页面': ['Camera access requires an HTTPS page.', '相機需要 HTTPS 頁面'],
  '正在打开相机…': ['Opening camera…', '正在開啟相機…'],
  '没有相机权限：请在浏览器设置里允许本网站使用相机': ['Allow camera access for this site in your browser settings.', '請在瀏覽器設定中允許這個網站使用相機'],
  '无法打开相机': ['Could not open the camera.', '無法開啟相機'],
  '电脑没有回应': ['The PC did not respond', '電腦沒有回應'],
  '这个光泡可能已经过期（每分钟换一次）。请对准电脑上当前的光泡重新扫描。': ['The bubble refreshes every minute. Scan the one now shown on your PC.', '光泡每分鐘更新一次。請重新掃描電腦目前顯示的光泡。'],
  '连接超时': ['Connection timed out', '連線逾時'],
  '请确认手机和电脑连着同一个网络，然后再试一次。': ['Connect your phone and PC to the same network, then try again.', '請確認手機和電腦連上同一個網路，再試一次。'],
  '连不上配对服务': ['Could not reach the pairing service', '無法連上配對服務'],
  '请检查手机的网络连接，然后再试一次。': ['Check your phone’s network connection, then try again.', '請檢查手機的網路連線，再試一次。'],
  '验证没有通过': ['Could not verify the connection', '驗證未通過'],
  '请重新扫描电脑上当前显示的光泡。': ['Scan the bubble currently shown on your PC.', '請重新掃描電腦目前顯示的光泡。'],
  '这个光泡正在和别的设备配对': ['This bubble is pairing with another device', '這個光泡正在與其他裝置配對'],
  '请等一下，或等电脑换一个新的光泡。': ['Wait for pairing to finish or for the PC to show a new bubble.', '請稍候，或等電腦顯示新的光泡。'],
  '没能连接': ['Could not connect', '無法連線'],
  '已识别': ['Code recognized', '已辨識'],
  '已读码，未配对': ['Code read. Pairing not started.', '已讀碼，尚未配對'],
  '这是只读码的测试模式。点「继续配对」后，电脑才会收到连接结果。': ['This is scan-only test mode. Tap Continue pairing to connect to the PC.', '目前是只讀碼的測試模式。點選「繼續配對」即可連線到電腦。'],
  '配对服务尚未配置。': ['The pairing service has not been configured.', '尚未設定配對服務。'],
  '配对码 …{code}。': ['Pairing code …{code}.', '配對碼 …{code}。'],
  '已识别，正在配对': ['Code recognized. Pairing…', '已辨識，正在配對'],
  '正在连接…': ['Connecting…', '正在連線…'],
  '正在连接配对服务…': ['Connecting to the pairing service…', '正在連線到配對服務…'],
  '已记住的电脑': ['Remembered computers', '已記住的電腦'],
  '移除': ['Remove', '移除'],
  '移除 {device}': ['Remove {device}', '移除 {device}'],
  '移除这台电脑？下次连接需要重新扫码。': ['Remove this computer? You will need to scan again next time.', '移除這台電腦？下次連線需要重新掃碼。'],
  '无法保存设备设置。': ['Could not save device settings.', '無法儲存裝置設定。'],
  '记住这台电脑？下次无需扫码。': ['Remember this computer to skip scanning next time?', '記住這台電腦？下次無需掃碼。'],
  '正在保存这台电脑…': ['Saving this computer…', '正在儲存這台電腦…'],
  '已记住这台电脑。': ['This computer was remembered.', '已記住這台電腦。'],
  '无法记住这台电脑，本次连接仍可使用。': ['Could not remember this computer. You can still use this connection.', '無法記住這台電腦，本次連線仍可使用。'],
  '已和 {device} 连接。': ['Connected to {device}.', '已與 {device} 連線。'],
  '请在电脑上打开 DockDrop。如果这台手机已被移除，请重新扫码。': ['Open DockDrop on the PC. If this phone was removed, scan again.', '請在電腦上開啟 DockDrop。如果這台手機已被移除，請重新掃碼。'],
  '请先在电脑端选文件或加入剪贴板文字，再连接。': ['Choose files or add clipboard text on the PC, then connect again.', '請先在電腦端選檔案或加入剪貼簿文字，再連線。'],
  '电脑没有接受这次传输。': ['The PC did not accept this transfer.', '電腦沒有接受這次傳輸。'],
  '正在等待电脑回应…': ['Waiting for the PC…', '正在等待電腦回應…'],
  '正在验证…': ['Verifying…', '正在驗證…'],
  '正在建立直连…': ['Establishing a direct connection…', '正在建立直接連線…'],
  '已连接': ['Connected', '已連線'],
  '已和 {device} 配对。': ['Paired with {device}.', '已與 {device} 配對。'],
  'DockOver 电脑': ['DockOver PC', 'DockOver 電腦'],
  '电脑': ['your PC', '電腦'],
  'Android 手机': ['Android phone', 'Android 手機'],
  '浏览器': ['Browser', '瀏覽器'],
  '正在发送': ['Sending', '正在傳送'],
  '正在等待电脑接收…': ['Waiting for the PC to receive…', '正在等待電腦接收…'],
  '正在发送 {name}{progress}': ['Sending {name}{progress}', '正在傳送 {name}{progress}'],
  '已发送': ['Sent', '已傳送'],
  '电脑已接收{contents}。': ['Your PC received {contents}.', '電腦已接收{contents}。'],
  '发送未完成': ['Transfer incomplete', '傳送未完成'],
  '收到的文字': ['Received text', '收到的文字'],
  '复制文字': ['Copy text', '複製文字'],
  '已复制': ['Copied', '已複製'],
  '保存 {name}': ['Save {name}', '儲存 {name}'],
  '等待电脑发送': ['Waiting for the PC', '等待電腦傳送'],
  '正在检查电脑要发送的内容…': ['Checking for items from the PC…', '正在檢查電腦要傳送的內容…'],
  '正在接收 {name}{progress}': ['Receiving {name}{progress}', '正在接收 {name}{progress}'],
  '这台电脑的版本可能只支持配对。若要接收文件或文字，请更新电脑端。': ['Update DockDrop on your PC to receive files or text here.', '請更新電腦上的 DockDrop，以便在此接收檔案或文字。'],
  '没有待发送内容': ['Nothing to receive', '沒有待傳送內容'],
  '请在电脑上重新打开 DockDrop，先选文件或加入剪贴板文字，再扫码。': ['Reopen DockDrop on your PC, choose files or add clipboard text, then scan again.', '請在電腦上重新開啟 DockDrop，先選擇檔案或加入剪貼簿文字，再掃描。'],
  '已接收': ['Received', '已接收'],
  '收到{contents}。': ['Received {contents}.', '收到{contents}。'],
  '接收未完成': ['Reception incomplete', '接收未完成'],
  '1 个文件': ['1 file', '1 個檔案'],
  '{count} 个文件': ['{count} files', '{count} 個檔案'],
  '{files}和文字': ['{files} and text', '{files}和文字'],
  '单个文件最大为 4 GB。': ['Each file must be 4 GB or smaller.', '每個檔案最大為 4 GB。'],
  '文字最多为 64 KB，且不能包含空字符。': ['Text must be 64 KB or smaller and contain no null characters.', '文字最多為 64 KB，且不能包含空字元。'],
  '电脑还未准备好接收，请使用新版 DockOver。': ['The PC is not ready to receive. Update DockOver and try again.', '電腦尚未準備好接收，請更新 DockOver 後重試。'],
  '电脑还未准备好接收，请更新 DockDrop。': ['The PC is not ready to receive. Update DockDrop and try again.', '電腦尚未準備好接收，請更新 DockDrop 後重試。'],
  '接收中断，请重新扫描后重试。': ['The transfer was interrupted. Scan again to retry.', '接收中斷，請重新掃描後重試。'],
  '接收的数据格式不完整。': ['The received data is incomplete.', '接收的資料格式不完整。'],
  '接收超时，请重新扫描。': ['Receiving timed out. Scan again to retry.', '接收逾時，請重新掃描。'],
  '文件大小与电脑提供的信息不符。': ['The file size did not match what the PC announced.', '檔案大小與電腦提供的資訊不符。'],
  '收到无效文件，或本次接收超过 128 MB／64 个文件。': ['Invalid file or the transfer exceeded 128 MB or 64 files.', '收到無效檔案，或本次接收超過 128 MB／64 個檔案。'],
  '文件接收不完整。': ['The file was only partially received.', '檔案接收不完整。'],
  '电脑中断了传输。': ['The PC stopped the transfer.', '電腦中斷了傳輸。'],
  '连接已断开，请重新扫描。': ['Connection lost. Scan again to retry.', '連線已中斷，請重新掃描。'],
  '电脑准备发送超时。': ['The PC took too long to start sending.', '電腦準備傳送逾時。'],
  '电脑未能完成发送。': ['The PC could not finish sending.', '電腦未能完成傳送。'],
  '电脑接收超时。': ['The PC took too long to respond.', '電腦接收逾時。'],
  '电脑无法读写传输内容。': ['The PC could not read or write the transfer.', '電腦無法讀寫傳輸內容。'],
  '电脑无法写入接收内容，请检查接收设置和可用空间。': ['The PC could not save the transfer. Check the destination and available space.', '電腦無法寫入接收內容，請檢查接收設定和可用空間。'],
  '请重新扫描后重试。': ['Scan again to retry.', '請重新掃描後重試。'],
  '二维码': ['QR code', 'QR 碼'],
  '光泡': ['Bubble', '光泡'],
  '识别：备用二维码（相机应用）': ['Scanned with the camera app', '辨識：備用 QR 碼（相機應用程式）'],
  '识别：{source} · 第一帧后 {time} s · 定位 {found}/{decoded} 帧 · 平均 {average} ms': [
    'Scan: {source} · {time} s after first frame · {found}/{decoded} frames located · {average} ms avg',
    '辨識：{source} · 首幀後 {time} s · 定位 {found}/{decoded} 幀 · 平均 {average} ms',
  ],
  '首次定位 {time} s': ['First lock {time} s', '首次定位 {time} s'],
  '纠正 {count} 字节': ['{count} bytes corrected', '修正 {count} 位元組'],
  '握手 {time} s': ['Handshake {time} s', '交握 {time} s'],
};

export function t(source, values = {}) {
  const entry = Object.hasOwn(messages, source) ? messages[source] : null;
  const text = (locale === 'en' ? entry?.[0] : locale === 'zh-Hant' ? entry?.[1] : null) || source;
  return text.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? values[key] : token);
}

export function transferError(message) {
  return t(Object.hasOwn(messages, message) ? message : '请重新扫描后重试。');
}

export function contentsLabel(count, includesText) {
  if (!count) return t('文字');
  const files = count === 1 ? t('1 个文件') : t('{count} 个文件', {count});
  return includesText ? t('{files}和文字', {files}) : files;
}

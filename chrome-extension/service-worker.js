// 抖音创作者自动回复助手 — Service Worker
// 用 chrome.alarms 实现精确后台定时，不受标签页后台节流影响
const ALARM_NAME = "douyin-ar-scan";
const TARGET_URL = "https://creator.douyin.com/creator-micro/*";

// 接收 content script 的消息：开启/停止定时
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SCHEDULE_START") {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: msg.intervalMin,
    });
    console.log(
      `[抖音自动回复 SW] 定时已设置，间隔 ${msg.intervalMin} 分钟`,
    );
  } else if (msg.type === "SCHEDULE_STOP") {
    chrome.alarms.clear(ALARM_NAME);
    console.log("[抖音自动回复 SW] 定时已清除");
  }
});

// alarm 触发 → 找到抖音标签页 → 通知 content script
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const tabs = await chrome.tabs.query({ url: TARGET_URL });
  if (tabs.length === 0) {
    console.log("[抖音自动回复 SW] alarm 触发，但无匹配标签页，跳过");
    return;
  }

  // 优先发送到未废弃的标签页
  const target = tabs.find((t) => !t.discarded) || tabs[0];
  if (target?.id != null) {
    try {
      await chrome.tabs.sendMessage(target.id, {
        type: "SCHEDULE_FIRE",
      });
      console.log(`[抖音自动回复 SW] 已通知标签页 ${target.id}`);
    } catch (e) {
      console.warn(`[抖音自动回复 SW] 通知标签页失败：${e.message}`);
    }
  }
});

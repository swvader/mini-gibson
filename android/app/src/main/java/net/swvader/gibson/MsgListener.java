package net.swvader.gibson;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

// 1.0.14: reads incoming message notifications (Google Messages / RCS included) and can reply via the notification's own
// direct-reply action when a thread is open. Plain SMS stays the fallback for new threads.
public class MsgListener extends NotificationListenerService {
  static volatile MsgListener inst;
  @Override public void onListenerConnected() { inst = this; push(); }
  @Override public void onListenerDisconnected() { if (inst == this) inst = null; }
  @Override public void onNotificationPosted(StatusBarNotification sbn) { push(); if (isMsg(sbn)) announce(sbn); }

  static boolean isMsg(StatusBarNotification s) {
    String c = s.getNotification().category; String p = s.getPackageName();
    return Notification.CATEGORY_MESSAGE.equals(c) || "com.google.android.apps.messaging".equals(p) || p.endsWith(".messaging") || p.contains("sms");
  }
  void announce(StatusBarNotification sbn) {
    try {
      Bundle ex = sbn.getNotification().extras; if (ex == null) return;
      CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE), text = ex.getCharSequence(Notification.EXTRA_TEXT);
      if (text == null) text = ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
      if (text == null || text.length() == 0) return;
      MainActivity a = MainActivity.inst == null ? null : MainActivity.inst.get();
      if (a != null) a.emit("sms", MainActivity.J("from", sbn.getPackageName(), "name", title == null ? "" : title.toString(), "body", text.toString()));
    } catch (Throwable e) {}
  }
  void push() {
    try {
      JSONArray arr = new JSONArray();
      for (StatusBarNotification sbn : getActiveNotifications()) { if (!isMsg(sbn)) continue;
        Bundle ex = sbn.getNotification().extras; if (ex == null) continue;
        CharSequence title = ex.getCharSequence(Notification.EXTRA_TITLE), text = ex.getCharSequence(Notification.EXTRA_TEXT);
        if (text == null) text = ex.getCharSequence(Notification.EXTRA_BIG_TEXT); if (text == null) continue;
        arr.put(new JSONObject().put("from", sbn.getPackageName()).put("name", title == null ? "" : title.toString()).put("body", text.toString()));
      }
      MainActivity a = MainActivity.inst == null ? null : MainActivity.inst.get();
      if (a != null) a.notifTexts = arr.toString();
    } catch (Throwable e) {}
  }
  // reply to an open thread by name (matches the notification title). "no-thread" when there isn't one -> caller uses SMS.
  String reply(String who, String text) {
    try {
      String w = who == null ? "" : who.trim().toLowerCase(); if (w.isEmpty()) return "no-thread";
      for (StatusBarNotification sbn : getActiveNotifications()) { if (!isMsg(sbn)) continue;
        Bundle ex = sbn.getNotification().extras; CharSequence title = ex == null ? null : ex.getCharSequence(Notification.EXTRA_TITLE);
        String t = title == null ? "" : title.toString().trim().toLowerCase();
        if (!t.equals(w) && !t.startsWith(w) && !w.startsWith(t)) continue;
        Notification n = sbn.getNotification(); if (n.actions == null) continue;
        for (Notification.Action act : n.actions) { if (act.getRemoteInputs() == null) continue;
          for (RemoteInput ri : act.getRemoteInputs()) { if (!ri.getAllowFreeFormInput()) continue;
            Intent fi = new Intent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Bundle b = new Bundle(); b.putCharSequence(ri.getResultKey(), text); RemoteInput.addResultsToIntent(new RemoteInput[]{ ri }, fi, b);
            try { act.actionIntent.send(this, 0, fi); return "ok"; } catch (PendingIntent.CanceledException e) { return "failed"; }
          }
        }
      }
    } catch (Throwable e) { return "error"; }
    return "no-thread";
  }
}

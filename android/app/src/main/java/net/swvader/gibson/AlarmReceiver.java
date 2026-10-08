package net.swvader.gibson;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.content.SharedPreferences;
import org.json.JSONObject;

// 1.0.11: reminders + timers. AlarmManager fires this even with the app in the background; it posts a notification,
// and if Gibson is open he also says it out loud (event "alarm" to the page).
public class AlarmReceiver extends BroadcastReceiver {
  static final String CH = "reminders";
  @Override public void onReceive(Context c, Intent i) {
    int id = i.getIntExtra("id", 0); String title = i.getStringExtra("title"), text = i.getStringExtra("text");
    try {
      NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
      if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CH, "Reminders and timers", NotificationManager.IMPORTANCE_HIGH));
      PendingIntent open = PendingIntent.getActivity(c, id, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CH) : new Notification.Builder(c);
      b.setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(title).setContentText(text).setAutoCancel(true).setContentIntent(open)
        .setCategory(Notification.CATEGORY_REMINDER).setDefaults(Notification.DEFAULT_ALL);
      nm.notify(id, b.build());
    } catch (Throwable e) {}
    removeAlarm(c, id);   // it fired; don't re-schedule it on next boot
    MainActivity a = MainActivity.inst == null ? null : MainActivity.inst.get();
    if (a != null) a.emit("alarm", MainActivity.J("id", id, "title", title, "text", text));
  }

  // persistence so reminders survive a reboot (BootReceiver re-schedules what's still pending)
  static SharedPreferences prefs(Context c) { return c.getSharedPreferences("gibson_alarms", Context.MODE_PRIVATE); }
  static void saveAlarm(Context c, int id, long at, String title, String text) {
    try { JSONObject all = new JSONObject(prefs(c).getString("a", "{}")); all.put(String.valueOf(id), new JSONObject().put("at", at).put("title", title == null ? "" : title).put("text", text == null ? "" : text)); prefs(c).edit().putString("a", all.toString()).apply(); } catch (Throwable e) {}
  }
  static void removeAlarm(Context c, int id) {
    try { JSONObject all = new JSONObject(prefs(c).getString("a", "{}")); all.remove(String.valueOf(id)); prefs(c).edit().putString("a", all.toString()).apply(); } catch (Throwable e) {}
  }
}

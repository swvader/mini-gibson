package net.swvader.gibson;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

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
    MainActivity a = MainActivity.inst == null ? null : MainActivity.inst.get();
    if (a != null) a.emit("alarm", MainActivity.J("id", id, "title", title, "text", text));
  }
}

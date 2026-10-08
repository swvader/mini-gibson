package net.swvader.gibson;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

// 1.0.12: after a reboot, re-schedule any reminders/timers that haven't fired yet.
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context c, Intent in) {
    try {
      JSONObject all = new JSONObject(AlarmReceiver.prefs(c).getString("a", "{}"));
      long now = System.currentTimeMillis();
      AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
      java.util.Iterator<String> it = all.keys();
      java.util.List<String> dead = new java.util.ArrayList<>();
      while (it.hasNext()) {
        String k = it.next(); JSONObject o = all.getJSONObject(k); long at = o.getLong("at");
        if (at <= now) { dead.add(k); continue; }
        int id = Integer.parseInt(k);
        Intent ri = new Intent(c, AlarmReceiver.class).putExtra("id", id).putExtra("title", o.optString("title")).putExtra("text", o.optString("text"));
        PendingIntent pi = PendingIntent.getBroadcast(c, id, ri, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        try { am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi); }
        catch (Throwable e) { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi); }
      }
      for (String k : dead) all.remove(k);
      AlarmReceiver.prefs(c).edit().putString("a", all.toString()).apply();
    } catch (Throwable e) {}
  }
}

package net.swvader.gibson;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.telephony.SmsMessage;

// 1.0.12: incoming text -> if Gibson is open he can read it aloud (creator only, enforced in JS).
public class SmsReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context c, Intent i) {
    try {
      Bundle b = i.getExtras(); if (b == null) return; Object[] pdus = (Object[]) b.get("pdus"); if (pdus == null) return;
      String fmt = b.getString("format"); String from = null; StringBuilder body = new StringBuilder();
      for (Object p : pdus) {
        SmsMessage m = Build.VERSION.SDK_INT >= 23 ? SmsMessage.createFromPdu((byte[]) p, fmt) : SmsMessage.createFromPdu((byte[]) p);
        if (m == null) continue; if (from == null) from = m.getOriginatingAddress(); body.append(m.getMessageBody());
      }
      MainActivity a = MainActivity.inst == null ? null : MainActivity.inst.get();
      if (a != null) a.emit("sms", MainActivity.J("from", from == null ? "" : from, "name", a.contactName(from), "body", body.toString()));
    } catch (Throwable e) {}
  }
}

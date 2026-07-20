/**
 * Settings, and the honest-limitations notice.
 *
 * That notice is not boilerplate and should not be moved, shortened, or hidden
 * behind a link. People make decisions about their physical safety based on
 * whether they believe this app works. They are entitled to know exactly what
 * it does not do, in the app, before they need it.
 */

import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Button, Card, Input } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

export default function SettingsScreen() {
  const t = useTheme();
  const { displayName, setDisplayName, status, startRadio, stopRadio, panicWipe } = useApp();
  const [name, setName] = useState(displayName);

  const confirmWipe = () =>
    Alert.alert(
      'Delete everything?',
      'Every message, every contact and your identity are erased from this phone. This cannot be undone, and the people you talked to will not be notified.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete everything', style: 'destructive', onPress: () => void panicWipe() },
      ],
    );

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.lg }}
      keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Settings' }} />

      <Card style={{ gap: Spacing.md }}>
        <Text style={[Type.label, { color: t.textMuted }]}>NAME OTHERS SEE NEARBY</Text>
        <Input value={name} onChangeText={setName} placeholder="anon" maxLength={32} />
        <Text style={[Type.caption, { color: t.textFaint }]}>
          This is broadcast in the clear to every phone in range. Do not use your real name.
        </Text>
        <Button
          title="Save"
          onPress={() => void setDisplayName(name)}
          disabled={name.trim() === displayName}
        />
      </Card>

      <Card style={{ gap: Spacing.md }}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[Type.bodyStrong, { color: t.text }]}>Mesh radio</Text>
            <Text style={[Type.caption, { color: t.textMuted }]}>
              {status.running ? 'On — reachable and relaying' : 'Off — nothing in or out'}
            </Text>
          </View>
          <Switch
            value={status.running}
            onValueChange={(on) => void (on ? startRadio() : stopRadio())}
          />
        </View>
      </Card>

      <Card style={{ gap: Spacing.md, borderColor: t.red }}>
        <Text style={[Type.bodyStrong, { color: t.red }]}>Panic wipe</Text>
        <Text style={[Type.caption, { color: t.textMuted }]}>
          Erases everything on this phone immediately and gives you a fresh identity.
        </Text>
        <Button title="Delete everything" variant="danger" onPress={confirmWipe} />
      </Card>

      <Card style={{ gap: Spacing.sm }}>
        <Text style={[Type.bodyStrong, { color: t.text }]}>What this does not protect you from</Text>
        {[
          'Your phone being taken while unlocked. Anyone holding it reads everything.',
          'Being physically located. Bluetooth is a radio; anyone with the right equipment can tell that a phone here is transmitting, even though they cannot read it.',
          'Someone standing next to you reading your screen.',
          'A contact you never verified in person turning out to be someone else.',
        ].map((line) => (
          <Text key={line} style={[Type.caption, { color: t.textMuted }]}>
            •  {line}
          </Text>
        ))}
        <Text style={[Type.caption, { color: t.textFaint, marginTop: Spacing.sm }]}>
          This software has not yet been independently audited. Treat it as useful, not as
          guaranteed. If your safety depends on it, assume a determined state adversary can still
          learn that you were present and transmitting.
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
});

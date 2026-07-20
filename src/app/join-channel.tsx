/**
 * Joining a channel.
 *
 * Key derivation is intentionally slow, so this screen shows real progress
 * rather than appearing frozen. The delay is a feature and is explained, not
 * apologised for.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';

import { Button, Card, Input } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

export default function JoinChannelScreen() {
  const t = useTheme();
  const router = useRouter();
  const { joinChannel } = useApp();

  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onJoin = async () => {
    setBusy(true);
    setError(null);
    try {
      // Yield a frame first so the spinner actually paints before scrypt takes
      // over the JS thread — otherwise the UI just freezes for a beat.
      await new Promise((r) => setTimeout(r, 32));
      const channel = await joinChannel(name, passphrase);
      router.replace(`/chat/${encodeURIComponent(`#${channel.id}`)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join.');
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.lg }}
      keyboardShouldPersistTaps="handled">
      <Card style={{ gap: Spacing.md }}>
        <Text style={[Type.label, { color: t.textMuted }]}>CHANNEL NAME</Text>
        <Input value={name} onChangeText={setName} placeholder="gate4" autoFocus />

        <Text style={[Type.label, { color: t.textMuted, marginTop: Spacing.sm }]}>PASSPHRASE</Text>
        <Input
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder="Shared secret"
          secureTextEntry
        />
        <Text style={[Type.caption, { color: t.textFaint }]}>
          Everyone who wants to read this channel types the same two things. There is no invite and
          no owner — the passphrase is the only thing that grants access.
        </Text>

        {!!error && <Text style={[Type.caption, { color: t.red }]}>{error}</Text>}

        {busy ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.md }}>
            <ActivityIndicator color={t.blue} />
            <Text style={[Type.caption, { color: t.textMuted }]}>
              Scrambling the passphrase… this takes a moment on purpose.
            </Text>
          </View>
        ) : (
          <Button
            title="Join channel"
            onPress={onJoin}
            disabled={!name.trim() || !passphrase}
          />
        )}
      </Card>

      <Card style={{ gap: Spacing.sm, borderColor: t.amber }}>
        <Text style={[Type.bodyStrong, { color: t.amber }]}>Before you use this</Text>
        {[
          'Anyone with the passphrase reads everything, including messages sent before they joined.',
          'You cannot remove someone. If the passphrase leaks, the channel is finished — start a new one with a new passphrase.',
          'A short passphrase like "delhi" can be guessed by someone who recorded the Bluetooth traffic. Use several unrelated words.',
        ].map((line) => (
          <Text key={line} style={[Type.caption, { color: t.textMuted }]}>
            •  {line}
          </Text>
        ))}
      </Card>
    </ScrollView>
  );
}

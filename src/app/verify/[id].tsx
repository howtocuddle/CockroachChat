/**
 * Safety number comparison.
 *
 * The only defence against someone having handed you a contact code that is not
 * theirs. Both phones derive the same 15 digits from the two public keys; if
 * the digits match, nobody is sitting in the middle.
 *
 * Written for someone who has never heard the phrase "man in the middle" and
 * should not have to.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card } from '@/components/ui';
import { Fonts, Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

export default function VerifyScreen() {
  const t = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const peerId = decodeURIComponent(id ?? '');

  const { contacts, safetyNumberFor, verifyContact } = useApp();
  const contact = contacts.find((c) => c.publicId === peerId);
  const digits = safetyNumberFor(peerId);

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.lg }}>
      <Stack.Screen options={{ title: contact?.name ?? 'Verify' }} />

      <Card style={{ gap: Spacing.lg }}>
        <Text style={[Type.title, { color: t.text }]}>Check these numbers together</Text>
        <Text style={[Type.body, { color: t.textMuted }]}>
          Hold your phones side by side. If both screens show the same numbers, your messages can
          only be read by the two of you.
        </Text>

        <View style={[styles.digits, { backgroundColor: t.surfaceRaised }]}>
          <Text
            selectable
            style={[styles.digitText, { color: t.text }]}
            accessibilityLabel={digits?.split('').join(' ') ?? ''}>
            {digits ?? '—'}
          </Text>
        </View>

        <Text style={[Type.caption, { color: t.textFaint }]}>
          Do this in person. Numbers read out over a phone call or sent in another app can be
          faked by whoever controls that channel.
        </Text>
      </Card>

      {contact?.verified ? (
        <Card style={{ gap: Spacing.md }}>
          <Text style={[Type.bodyStrong, { color: t.green }]}>Marked as verified</Text>
          <Button
            title="Undo"
            variant="secondary"
            onPress={async () => {
              await verifyContact(peerId, false);
            }}
          />
        </Card>
      ) : (
        <View style={{ gap: Spacing.md }}>
          <Button
            title="They match — mark verified"
            onPress={async () => {
              await verifyContact(peerId, true);
              router.back();
            }}
          />
          <Button title="They do not match" variant="danger" onPress={() => router.back()} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  digits: { borderRadius: Radius.md, paddingVertical: Spacing.xl, paddingHorizontal: Spacing.lg },
  digitText: {
    fontFamily: Fonts.mono,
    fontSize: 28,
    letterSpacing: 3,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});

/**
 * Adding a person.
 *
 * This screen is the trust anchor for the entire app. There is no server and no
 * directory, so the only thing that establishes who someone is, is the two of
 * you being in the same place and one phone reading the other's screen.
 *
 * Which means it has to be fast and impossible to get wrong. Show a QR code,
 * point a camera at it, done. The typed-code path exists only as a fallback for
 * a broken camera or a denied permission, and it is deliberately secondary.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, Card, Input } from '@/components/ui';
import { Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

/** Namespaced so a random QR code in the wild cannot be mistaken for a contact. */
const QR_PREFIX = 'protestchat:';

export default function AddScreen() {
  const t = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { identity, displayName, addContact } = useApp();

  const [mode, setMode] = useState<'show' | 'scan'>('show');
  const [permission, requestPermission] = useCameraPermissions();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const myCode = identity ? `${QR_PREFIX}${identity.publicId}` : '';
  const qrSize = Math.min(width - Spacing.lg * 6, 260);

  const accept = async (raw: string) => {
    const value = raw.trim().replace(QR_PREFIX, '');
    const ok = await addContact(value);
    if (!ok) {
      setError('That is not a valid contact code.');
      handled.current = false;
      return;
    }
    router.back();
  };

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.lg }}
      keyboardShouldPersistTaps="handled">
      <View style={[styles.toggle, { backgroundColor: t.surface, borderColor: t.border }]}>
        <Toggle label="My code" active={mode === 'show'} onPress={() => setMode('show')} />
        <Toggle
          label="Scan theirs"
          active={mode === 'scan'}
          onPress={() => {
            handled.current = false;
            setMode('scan');
            if (!permission?.granted) void requestPermission();
          }}
        />
      </View>

      {mode === 'show' ? (
        <Card style={{ alignItems: 'center', gap: Spacing.lg }}>
          <Text style={[Type.title, { color: t.text }]}>{displayName}</Text>
          <View style={styles.qrFrame}>
            {!!myCode && (
              // Always light-on-white regardless of theme: a dark-mode QR code
              // is a QR code that half of scanners refuse to read.
              <QRCode value={myCode} size={qrSize} backgroundColor="#FFFFFF" color="#000000" />
            )}
          </View>
          <Text style={[Type.body, { color: t.textMuted, textAlign: 'center' }]}>
            Let the other person scan this. Do it standing next to them — that is what makes it
            safe.
          </Text>
          <Button
            title="Copy code instead"
            variant="secondary"
            onPress={() => Clipboard.setStringAsync(myCode)}
          />
        </Card>
      ) : (
        <Card style={{ gap: Spacing.lg, padding: Spacing.md }}>
          <View style={[styles.camera, { borderColor: t.border }]}>
            {permission?.granted ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => {
                  // The camera fires continuously; without this latch a single
                  // code adds the same contact dozens of times.
                  if (handled.current || !data.startsWith(QR_PREFIX)) return;
                  handled.current = true;
                  void accept(data);
                }}
              />
            ) : (
              <View style={styles.cameraFallback}>
                <Text style={[Type.body, { color: t.textMuted, textAlign: 'center' }]}>
                  Camera access is off. You can still paste their code below.
                </Text>
              </View>
            )}
          </View>
        </Card>
      )}

      <Card style={{ gap: Spacing.md }}>
        <Text style={[Type.label, { color: t.textMuted }]}>OR PASTE THEIR CODE</Text>
        <Input
          value={typed}
          onChangeText={(v) => {
            setTyped(v);
            setError(null);
          }}
          placeholder="protestchat:…"
          multiline
          style={{ minHeight: 88 }}
        />
        {!!error && <Text style={[Type.caption, { color: t.red }]}>{error}</Text>}
        <Button title="Add person" onPress={() => accept(typed)} disabled={!typed.trim()} />
      </Card>
    </ScrollView>
  );
}

function Toggle({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Button
      title={label}
      variant={active ? 'primary' : 'secondary'}
      onPress={onPress}
      style={{ flex: 1, backgroundColor: active ? t.blue : 'transparent' }}
    />
  );
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    gap: Spacing.xs,
    padding: Spacing.xs,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  qrFrame: { padding: Spacing.lg, backgroundColor: '#FFFFFF', borderRadius: Radius.md },
  camera: {
    aspectRatio: 1,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  cameraFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
});

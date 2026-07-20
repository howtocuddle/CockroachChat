/**
 * Home.
 *
 * Answers two questions and nothing else: "is it working?" and "who can I talk
 * to?" Anything that is not one of those two answers belongs on another screen.
 *
 * Ordering is deliberate. Public broadcast sits at the top because it is the
 * thing someone reaches for in an emergency, and it carries a permanent red
 * label so that convenience never reads as safety.
 */

import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StatusBanner } from '@/components/status-banner';
import { Button, Card, Empty, Row } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

export default function HomeScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { status, contacts, conversations, channels, groups, refresh, ready } = useApp();

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const last = new Map(conversations.map((c) => [c.peerId, c]));
  const open = (id: string) => router.push(`/chat/${encodeURIComponent(id)}`);

  const publicChannel = channels.find((c) => c.kind === 'public');
  const joined = channels.filter((c) => c.kind === 'channel');

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: insets.bottom + 140 }}
        keyboardShouldPersistTaps="handled">
        <StatusBanner status={status} />

        {publicChannel && (
          <>
            <SectionHeader title="BROADCAST" />
            <Card style={{ padding: 0, overflow: 'hidden' }}>
              <Row
                title="Everyone nearby"
                subtitle={last.get('#public')?.lastText ?? 'Anyone in range can read this'}
                onPress={() => open('#public')}
                accessory={<Text style={[Type.caption, { color: t.red }]}>NOT PRIVATE</Text>}
              />
            </Card>
          </>
        )}

        <SectionHeader
          title="CHANNELS"
          action="Join"
          onAction={() => router.push('/join-channel')}
        />
        {joined.length === 0 ? (
          <Card>
            <Text style={[Type.body, { color: t.textMuted }]}>
              A channel is a name and a passphrase. Anyone you tell the passphrase to can read it.
            </Text>
          </Card>
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {joined.map((c, i) => (
              <View key={c.id}>
                {i > 0 && <Separator />}
                <Row
                  title={`#${c.name}`}
                  subtitle={last.get(`#${c.id}`)?.lastText ?? 'No messages yet'}
                  onPress={() => open(`#${c.id}`)}
                  accessory={<Text style={[Type.caption, { color: t.amber }]}>Shared key</Text>}
                />
              </View>
            ))}
          </Card>
        )}

        <SectionHeader
          title="GROUPS"
          action="New"
          onAction={() => router.push('/new-group')}
        />
        {groups.length === 0 ? (
          <Card>
            <Text style={[Type.body, { color: t.textMuted }]}>
              A group is encrypted separately to each person you add. Only they can read it.
            </Text>
          </Card>
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {groups.map((g, i) => (
              <View key={g.id}>
                {i > 0 && <Separator />}
                <Row
                  title={g.name}
                  subtitle={
                    last.get(`~${g.id}`)?.lastText ??
                    `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}`
                  }
                  onPress={() => open(`~${g.id}`)}
                  accessory={<Text style={[Type.caption, { color: t.green }]}>Private</Text>}
                />
              </View>
            ))}
          </Card>
        )}

        <SectionHeader title="PEOPLE" />
        {contacts.length === 0 ? (
          <Card>
            <Empty
              title={ready ? 'Nobody added yet' : 'Starting up…'}
              detail="Add someone by swapping contact codes in person. It takes about ten seconds, and it is the one step that actually protects you."
            />
          </Card>
        ) : (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {contacts.map((c, i) => (
              <View key={c.publicId}>
                {i > 0 && <Separator />}
                <Row
                  title={c.name}
                  subtitle={last.get(c.publicId)?.lastText ?? 'No messages yet'}
                  onPress={() => open(c.publicId)}
                  accessory={
                    <Text style={[Type.caption, { color: c.verified ? t.green : t.amber }]}>
                      {c.verified ? 'Verified' : 'Unverified'}
                    </Text>
                  }
                />
              </View>
            ))}
          </Card>
        )}
      </ScrollView>

      <View
        style={[
          styles.footer,
          {
            paddingBottom: insets.bottom + Spacing.lg,
            backgroundColor: t.bg,
            borderColor: t.border,
          },
        ]}>
        <Button title="Add a person" onPress={() => router.push('/add')} />
      </View>
    </View>
  );
}

function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[Type.label, { color: t.textMuted }]}>{title}</Text>
      <View style={{ flexDirection: 'row', gap: Spacing.lg }}>
        {action && onAction && (
          <Pressable hitSlop={12} onPress={onAction} accessibilityRole="button">
            <Text style={[Type.label, { color: t.blue }]}>{action}</Text>
          </Pressable>
        )}
        {title === 'BROADCAST' && (
          <Link href="/settings" asChild>
            <Pressable hitSlop={12} accessibilityRole="button" accessibilityLabel="Settings">
              <Text style={[Type.label, { color: t.blue }]}>Settings</Text>
            </Pressable>
          </Link>
        )}
      </View>
    </View>
  );
}

function Separator() {
  const t = useTheme();
  return <View style={[styles.sep, { backgroundColor: t.border }]} />;
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.xl,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: Spacing.lg },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});

/**
 * Creating a closed group.
 *
 * Membership is local. This is *your* list of who you send to, not a
 * synchronised roster — two members can disagree about who is in the group.
 * That is a real limitation of fan-out and the screen says so rather than
 * pretending otherwise.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Input } from '@/components/ui';
import { Radius, Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';
import { MAX_GROUP_MEMBERS } from '@/lib/conversation';

export default function NewGroupScreen() {
  const t = useTheme();
  const router = useRouter();
  const { contacts, createGroup } = useApp();

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const toggle = (publicId: string) => {
    setError(null);
    setSelected((prev) => {
      if (prev.includes(publicId)) return prev.filter((p) => p !== publicId);
      if (prev.length >= MAX_GROUP_MEMBERS) {
        setError(`Groups are limited to ${MAX_GROUP_MEMBERS} people over Bluetooth.`);
        return prev;
      }
      return [...prev, publicId];
    });
  };

  const onCreate = async () => {
    await createGroup(name, selected);
    router.back();
  };

  const unverifiedSelected = contacts.filter(
    (c) => selected.includes(c.publicId) && !c.verified,
  ).length;

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.lg }}
      keyboardShouldPersistTaps="handled">
      <Card style={{ gap: Spacing.md }}>
        <Text style={[Type.label, { color: t.textMuted }]}>GROUP NAME</Text>
        <Input value={name} onChangeText={setName} placeholder="Legal support" autoFocus />
      </Card>

      <Card style={{ gap: Spacing.md }}>
        <Text style={[Type.label, { color: t.textMuted }]}>
          MEMBERS ({selected.length}/{MAX_GROUP_MEMBERS})
        </Text>

        {contacts.length === 0 ? (
          <Text style={[Type.body, { color: t.textMuted }]}>
            Add some people first — a group can only contain contacts you have already swapped codes
            with.
          </Text>
        ) : (
          contacts.map((c) => {
            const on = selected.includes(c.publicId);
            return (
              <Pressable
                key={c.publicId}
                onPress={() => toggle(c.publicId)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={[styles.member, { borderColor: on ? t.blue : t.border }]}>
                <View
                  style={[
                    styles.check,
                    { borderColor: on ? t.blue : t.border, backgroundColor: on ? t.blue : 'transparent' },
                  ]}>
                  {on && <Text style={{ color: '#FFF', fontWeight: '700' }}>✓</Text>}
                </View>
                <Text style={[Type.body, { color: t.text, flex: 1 }]}>{c.name}</Text>
                <Text style={[Type.caption, { color: c.verified ? t.green : t.amber }]}>
                  {c.verified ? 'Verified' : 'Unverified'}
                </Text>
              </Pressable>
            );
          })
        )}

        {!!error && <Text style={[Type.caption, { color: t.red }]}>{error}</Text>}
      </Card>

      {unverifiedSelected > 0 && (
        <Card style={{ borderColor: t.amber, gap: Spacing.sm }}>
          <Text style={[Type.bodyStrong, { color: t.amber }]}>
            {unverifiedSelected} unverified {unverifiedSelected === 1 ? 'member' : 'members'}
          </Text>
          <Text style={[Type.caption, { color: t.textMuted }]}>
            You have not checked safety numbers with everyone here. If any of those codes came from
            someone impersonating them, that person reads this group.
          </Text>
        </Card>
      )}

      <Card style={{ gap: Spacing.sm }}>
        <Text style={[Type.caption, { color: t.textFaint }]}>
          Each message is encrypted separately for every member, so a group of ten sends ten copies
          over the radio. Membership is stored only on your phone — other members see the messages,
          not the member list, and their idea of who is in the group may differ from yours.
        </Text>
      </Card>

      <Button
        title={`Create group with ${selected.length} ${selected.length === 1 ? 'person' : 'people'}`}
        onPress={onCreate}
        disabled={selected.length === 0}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  member: {
    minHeight: TAP_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

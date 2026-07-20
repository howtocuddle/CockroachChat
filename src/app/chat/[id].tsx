/**
 * A conversation — direct, group, channel, or public broadcast.
 *
 * The mode strip at the top is the most important element on this screen and is
 * never dismissible, never collapsible, and never quieter for the less private
 * modes. Someone typing a location into public broadcast because it looked like
 * a normal chat is the worst thing this app can do to a person.
 *
 * For the same reason the composer placeholder changes per mode: the last thing
 * you read before typing should tell you who is about to read it.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Empty, Input } from '@/components/ui';
import { Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';
import { describeConversation } from '@/lib/conversation';
import * as db from '@/lib/db';

export default function ChatScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = decodeURIComponent(id ?? '');

  const { contacts, conversations, channels, groups, sendText, status } = useApp();
  const contact = contacts.find((c) => c.publicId === conversationId);

  const info = useMemo(
    () =>
      describeConversation(conversationId, {
        channels,
        groups,
        contactName: contact?.name,
        verified: contact?.verified,
      }),
    [conversationId, channels, groups, contact],
  );

  const [messages, setMessages] = useState<db.Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<db.Message>>(null);

  const nameFor = useCallback(
    (publicId: string | null) =>
      publicId ? (contacts.find((c) => c.publicId === publicId)?.name ?? 'unknown') : 'unknown',
    [contacts],
  );

  const load = useCallback(async () => {
    if (conversationId) setMessages(await db.listMessages(conversationId));
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, conversations]);

  // Messages arrive over the radio, not from anything React knows about, so a
  // modest poll is the honest way to keep this list live.
  useEffect(() => {
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendText(conversationId, text);
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const stripColor =
    info.tone === 'danger' ? t.red : info.tone === 'caution' ? t.amber : t.green;

  const placeholder =
    info.mode === 'public'
      ? 'Anyone nearby will read this'
      : info.mode === 'channel'
        ? 'Anyone with the passphrase will read this'
        : 'Message';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}>
      <Stack.Screen options={{ title: info.title }} />

      <Pressable
        // Only the direct-message warning leads anywhere: verification is the
        // one warning a user can actually act on.
        onPress={
          info.mode === 'direct' && !contact?.verified
            ? () => router.push(`/verify/${encodeURIComponent(conversationId)}`)
            : undefined
        }
        style={[styles.strip, { backgroundColor: t.surface, borderColor: stripColor }]}>
        <Text style={[Type.caption, { color: stripColor }]}>{info.warning}</Text>
      </Pressable>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm, flexGrow: 1 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Empty
            title="No messages yet"
            detail={
              status.connected.length > 0
                ? 'You are connected. Say something.'
                : 'Messages you send now will wait on your phone and go out as soon as someone is in range.'
            }
          />
        }
        renderItem={({ item }) => (
          <Bubble
            message={item}
            senderName={info.showSenders && !item.outgoing ? nameFor(item.senderId) : null}
          />
        )}
      />

      {error && (
        <Text style={[Type.caption, { color: t.red, paddingHorizontal: Spacing.lg }]}>{error}</Text>
      )}

      <View
        style={[
          styles.composer,
          {
            borderColor: t.border,
            backgroundColor: t.bg,
            paddingBottom: insets.bottom || Spacing.lg,
          },
        ]}>
        <Input
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          multiline
          style={{ flex: 1, maxHeight: 120 }}
        />
        <Button title="Send" onPress={onSend} disabled={!draft.trim() || sending} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ message, senderName }: { message: db.Message; senderName: string | null }) {
  const t = useTheme();
  const mine = message.outgoing;

  // "Queued" is not a failure and must not look like one — with
  // store-and-forward it is the normal state of a message that is on its way.
  const stateLabel =
    message.state === 'queued'
      ? 'Waiting for someone in range'
      : message.state === 'sent'
        ? 'Sent'
        : message.state === 'delivered'
          ? 'Delivered'
          : 'Failed';

  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      {!!senderName && (
        <Text style={[Type.caption, { color: t.textFaint, marginLeft: Spacing.sm }]}>
          {senderName}
        </Text>
      )}
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: mine ? t.bubbleOut : t.bubbleIn,
            borderBottomRightRadius: mine ? Radius.sm : Radius.lg,
            borderBottomLeftRadius: mine ? Radius.lg : Radius.sm,
          },
        ]}>
        <Text style={[Type.body, { color: mine ? '#FFFFFF' : t.text }]}>{message.text}</Text>
      </View>
      {mine && (
        <Text style={[Type.caption, { color: message.state === 'failed' ? t.red : t.textFaint }]}>
          {stateLabel}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    margin: Spacing.lg,
    marginBottom: 0,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});

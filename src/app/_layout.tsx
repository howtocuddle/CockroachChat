import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { AppProvider } from '@/lib/app-state';

export default function RootLayout() {
  const scheme = useColorScheme();
  const t = scheme === 'light' ? Colors.light : Colors.dark;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.bg },
            headerTintColor: t.text,
            headerTitleStyle: { fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.bg },
          }}>
          <Stack.Screen name="index" options={{ title: 'Nearby' }} />
          <Stack.Screen name="chat/[id]" options={{ title: '' }} />
          <Stack.Screen name="add" options={{ title: 'Add a person', presentation: 'modal' }} />
          <Stack.Screen name="verify/[id]" options={{ title: 'Verify' }} />
          <Stack.Screen
            name="join-channel"
            options={{ title: 'Join a channel', presentation: 'modal' }}
          />
          <Stack.Screen name="new-group" options={{ title: 'New group', presentation: 'modal' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}

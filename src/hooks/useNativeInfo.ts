import { useEffect, useState } from "react";
import { isNative, nativeInfo, type NativeInfo } from "@/lib/native";

/** What the native app reports about itself (null in the browser / loading). */
export function useNativeInfo() {
  const [info, setInfo] = useState<NativeInfo | null>(null);
  const native = isNative();
  useEffect(() => {
    if (native) void nativeInfo().then(i => setInfo(i ?? null));
  }, [native]);
  return [info, setInfo] as const;
}

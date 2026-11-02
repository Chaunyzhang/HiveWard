import { clipboard } from 'electron'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { readClipboardCopiedFilePaths } from '../window/clipboard-copied-file-paths'
import { runClipboardHelper } from './clipboard-process'

const MAC_SEQUENCE_SCRIPT = `
ObjC.import('AppKit');
var pasteboard = $.NSPasteboard.generalPasteboard;
while (true) {
  console.log(String(pasteboard.changeCount));
  $.NSThread.sleepForTimeInterval(0.5);
}
`

const MAC_WRITE_FILES_SCRIPT = `
ObjC.import('AppKit');
var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile();
var json = $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding).js;
var paths = JSON.parse(json);
var urls = $.NSMutableArray.array;
paths.forEach(function(path) {
  urls.addObject($.NSURL.fileURLWithPath(path));
});
var pasteboard = $.NSPasteboard.generalPasteboard;
pasteboard.clearContents();
if (!pasteboard.writeObjects(urls)) {
  $.exit(1);
}
`

export function macClipboardSequenceSpec(): ProcessSpec {
  return {
    program: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', MAC_SEQUENCE_SCRIPT],
    env: process.env,
    detached: true
  }
}

export function readMacClipboardFiles(): string[] {
  return readClipboardCopiedFilePaths(clipboard, 'darwin')
}

export async function writeMacClipboardFiles(
  paths: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  await runClipboardHelper(
    {
      program: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '-e', MAC_WRITE_FILES_SCRIPT],
      env: process.env,
      input: JSON.stringify(paths)
    },
    signal
  )
}

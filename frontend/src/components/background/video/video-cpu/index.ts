import { createVideoBackground } from './renderer';
import { readVideoBlob } from './storage';

export const start = createVideoBackground({ readSource: readVideoBlob });

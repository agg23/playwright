/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getFromENV } from './env';

export function assert(value: any, message?: string): asserts value {
  if (!value) {
    throw new Error(message || 'Assertion error');
  }
}

export function debugAssert(value: any, message?: string): asserts value {
  if (isUnderTest() && !value) {
    throw new Error(message);
  }
}

const debugEnv = getFromENV('PWDEBUG') || '';
export function debugMode() {
  if (debugEnv === 'console') {
    return 'console';
  }
  if (debugEnv === '0' || debugEnv === 'false') {
    return '';
  }
  return debugEnv ? 'inspector' : '';
}

let _isUnderTest = !!process.env.PWTEST_UNDER_TEST;
export function setUnderTest() {
  _isUnderTest = true;
}

export function isUnderTest(): boolean {
  return _isUnderTest;
}

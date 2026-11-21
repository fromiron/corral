import { expect, it } from 'vitest';
import { permissionList } from './BrowserLines.tsx';

it('권한의 이름을 그 말의 목록으로 잇는다: 한국어는 와/과로 잇고 끝에 을/를을 붙인다', () => {
  expect(permissionList(['카메라', '마이크'], 'ko')).toBe('카메라와 마이크를');
  expect(permissionList(['알림'], 'ko')).toBe('알림을');
  expect(permissionList(['위치'], 'ko')).toBe('위치를');
  expect(permissionList(['알림', '위치'], 'ko')).toBe('알림과 위치를');
  expect(permissionList(['로컬 네트워크', '카메라', '마이크'], 'ko')).toBe(
    '로컬 네트워크, 카메라와 마이크를',
  );
  expect(permissionList(['camera', 'microphone'], 'en')).toBe('camera and microphone');
});

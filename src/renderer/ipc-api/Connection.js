'use strict';
import { ipcRenderer } from 'electron';

import connStringConstruct from '../libs/connStringDecode';

export default class {
   static makeTest (params) {
      params = connStringConstruct(params);
      return ipcRenderer.invoke('test-connection', params);
   }

   static connect (params) {
      params = connStringConstruct(params);
      return ipcRenderer.invoke('connect', params);
   }

   static checkConnection (uid) {
      return ipcRenderer.invoke('check-connection', uid);
   }

   static disconnect (uid) {
      return ipcRenderer.invoke('disconnect', uid);
   }
}

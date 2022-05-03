<template>
   <div>
      <label class="empty">
         <input
            :disabled="disabled"
            class="input"
            @input="getOptions"
         >
         <span v-if="clearable" @click="clearInput">x</span>
      </label>
      <ul v-if="hasDropdown && showDropdown">
         <li
            v-for="(option, index) in options"
            :key="index"
         >
            {{ option }}
         </li>
      </ul>
   </div>
</template>

<script>
import inputMixin from '../mixins/inputMixin';

export default {
   name: 'BaseAutocompleteInput',
   mixins: [inputMixin],
   props: {
      fetcher: {
         type: Function,
         required: true
      }
   },
   data: function () {
      return {
         options: null
      };
   },
   methods: {
      getOptions () {
         this.options = this.fetcher();
      }
   }
};
</script>
<style scoped>
.empty {
  position: absolute;
  display: flex;
  height: 100%;
  flex-direction: column;
  left: 0;
  justify-content: center;
  right: 0;
}
</style>

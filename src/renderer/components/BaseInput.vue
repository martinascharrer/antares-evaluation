<template>
   <div>
      <label class="empty">
         <input
            :disabled="disabled"
            class="loading loading-lg"
         >
         <span v-if="clearable" @click="clearInput">x</span>
      </label>
      <ul v-if="hasDropdown && showDropdown">
         <li>item 1</li>
         <li>item 2</li>
         <li>item 3</li>
      </ul>
   </div>
</template>

<script>
import inputMixin from '../mixins/inputMixin';

export default {
   name: 'BaseInput',
   mixins: [inputMixin],
   props: {
      maxLength: {
         type: Number,
         default: 50
      },
      label: {
         type: String,
         default: 'label'
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

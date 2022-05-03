export default {
   props: {
      disabled: {
         type: Boolean,
         default: false
      },
      clearable: {
         type: Boolean,
         default: false
      },
      hasDropdown: {
         type: Boolean,
         default: false
      }
   },
   data () {
      return {
         showDropdown: false
      };
   },
   methods: {
      openDropdown () {
         this.showDropdown = true;
         this.$emit('dropDownOpened');
      },
      clearInput () {
         this.$emit('inputCleared');
      }
   }
};

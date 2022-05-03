<template>
   <div class="column col-12 empty">
      <p class="h6 empty-subtitle">
         {{ $t('message.thereAreNoTableFields') }}
      </p>
      Table name:
      <base-autocomplete-input
         clearable
         has-dropdown
         :fetcher="() => ['one', 'two', 'three']"
         @dropDownOpened="() => console.log('have fun')"
      />
      Table place:
      <base-input
         max-length="20"
         label="table place"
         clearable
         has-dropdown
         @inputCleared="() => console.log('hi')"
      />
      <div class="empty-action">
         <button class="btn btn-gray d-flex" @click="$emit('new-field')">
            <i class="mdi mdi-24px mdi-playlist-plus mr-2" />
            {{ $t('message.addNewField') }}
         </button>
      </div>
   </div>
</template>

<script>
import BaseAutocompleteInput from './BaseAutocompleteInput';
import BaseInput from './BaseInput';
export default {
   name: 'WorkspaceTabNewTableEmptyState',
   components: { BaseInput, BaseAutocompleteInput }
};
</script>

<style scoped>
  .empty {
    border-radius: 0;
    background: transparent;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    margin-left: auto;
    margin-right: auto;
    z-index: 9;
  }
</style>

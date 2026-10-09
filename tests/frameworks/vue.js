import {createApp, ref, h, withDirectives, vModelText} from 'vue';
createApp({setup() {
  const user=ref(''); const pass=ref('');
  return () => {
    window.frameworkState = {user:user.value,pass:pass.value};
    return h('form', {onSubmit:e=>e.preventDefault()}, [h('label',{for:'user'},'Username'),withDirectives(h('input',{id:'user',autocomplete:'username','onUpdate:modelValue':value=>user.value=value}),[[vModelText,user.value]]),h('label',{for:'pass'},'Password'),withDirectives(h('input',{id:'pass',type:'password',autocomplete:'current-password','onUpdate:modelValue':value=>pass.value=value}),[[vModelText,pass.value]])]);
  };
}}).mount('#mount');

import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
function Login() {
  const [user, setUser] = useState(''); const [pass, setPass] = useState('');
  window.frameworkState = {user,pass};
  return React.createElement('form', {onSubmit:event=>event.preventDefault()},
    React.createElement('label', {htmlFor:'user'}, 'Username'),
    React.createElement('input', {id:'user',autoComplete:'username',value:user,onChange:event=>setUser(event.target.value)}),
    React.createElement('label', {htmlFor:'pass'}, 'Password'),
    React.createElement('input', {id:'pass',type:'password',autoComplete:'current-password',value:pass,onChange:event=>setPass(event.target.value)}));
}
createRoot(document.querySelector('#mount')).render(React.createElement(Login));
